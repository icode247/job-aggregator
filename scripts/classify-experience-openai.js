#!/usr/bin/env node
/**
 * One-time backfill: classify experience_level for jobs that are unclassified
 * (experience_level IS NULL OR '') using OpenAI, reading title + description.
 *
 * Targets LIVE jobs only (removed_at IS NULL) that have a description.
 * Forward-only by id, so it's naturally resumable: rows it classifies leave the
 * target set, and a fresh run continues with whatever is still unclassified.
 *
 * Connection: process.env.DB_URL (Heroku DATABASE_URL), same as sync-jobs-to-postgres.js.
 *   DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *   OPENAI_API_KEY=sk-... node scripts/classify-experience-openai.js
 *
 * Env knobs:
 *   OPENAI_API_KEY  required.
 *   DB_URL          required (Heroku Postgres connection string).
 *   MODEL           OpenAI model. Default 'gpt-4o-mini'.
 *   READ_BATCH      rows fetched from Postgres per page. Default 300.
 *   REQ_BATCH       jobs per OpenAI request. Default 15.
 *   CONCURRENCY     parallel OpenAI requests. Default 6.
 *   DESC_CHARS      description chars sent per job. Default 600.
 *   LIMIT           cap total jobs processed (for a test run). Default 0 = no cap.
 *   DRY_RUN         '1' to classify + log but NOT write to the DB.
 */
const { Client } = require('pg');

const MODEL = process.env.MODEL || 'gpt-4o-mini';
const READ_BATCH = parseInt(process.env.READ_BATCH || '300', 10);
const REQ_BATCH = parseInt(process.env.REQ_BATCH || '15', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);
const DESC_CHARS = parseInt(process.env.DESC_CHARS || '600', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
// SHUFFLE=1: sample a diverse cross-section (ORDER BY random(), single page) instead
// of the forward-by-id scan. For spot-checking quality only — not the production run.
// (Named SHUFFLE, not RANDOM, because $RANDOM is a special shell var and won't export.)
const RANDOM = process.env.SHUFFLE === '1' || process.env.SHUFFLE === 'true';
// TITLE_LIKE: restrict the target set to titles matching an ILIKE pattern (case-insensitive,
// substring). For verifying the rubric on a known pattern or running a targeted corrective pass.
const TITLE_LIKE = process.env.TITLE_LIKE || '';

const LEVELS = ['internship', 'entry', 'mid', 'senior', 'lead', 'executive'];
const ALLOWED = new Set([...LEVELS, 'unknown']);

// gpt-4o-mini rates ($/1M tokens) for a rough live cost readout.
const PRICE_IN = 0.15, PRICE_OUT = 0.60;

const SYSTEM_PROMPT = `You label job postings with a single seniority level: internship, entry, mid, senior, lead, or executive. Decide in this order.

1) EXPLICIT TITLE MARKER wins:
   - internship: intern, co-op, apprentice, trainee, working/summer student.
   - entry: junior, jr., entry-level, new grad / graduate program, "Engineer I", and clearly junior roles like Sales Development Representative (SDR), Sourcer, or entry support/associate roles.
   - mid: mid-level, "Engineer II/III".
   - senior: senior, sr., staff, principal, OR an individual-contributor "Lead <role>" such as "Lead Software Engineer" (a senior IC, not a people manager).
   - lead: people/team leadership below the executive line — team lead, tech lead, engineering manager, group lead, "Head of <a function/team>", manager of people.
   - executive: VP, SVP, Director, C-suite (CTO/CEO/CFO/etc.), Chief, Partner, Founder, or "Head of <a whole org/department>". A title is NOT executive just because it sounds important: words like Evangelist, Advocate, Ambassador, Specialist, Architect, Strategist, Analyst, Coordinator, or an individual-contributor Principal are NOT executive unless paired with VP/Director/Chief/Head-of-org.
   - FALSE FRIEND — "Executive" inside a SALES title does NOT mean C-suite: "Account Executive", "Sales Executive", "Advertising Executive", "Enterprise Account Executive" are SALES individual contributors, never "executive" level. Rank them on the sales ladder below.

SALES LADDER (the word "Executive" here is a sales IC, not C-suite):
   - SDR / BDR / Sales Development / Business Development Rep / Sourcer / Sales Associate / Sales Assistant → entry
   - Account Executive (AE), Sales Executive, Account Manager → mid
   - Enterprise / Strategic / Senior Account Executive, Enterprise Hunter → senior
   - Only "VP of Sales", "Sales Director", "Chief Revenue Officer", "Head of Sales" → executive

2) IF THE TITLE HAS NO SENIORITY MARKER, infer from the DESCRIPTION's required years of experience / scope:
   - 0-2 years, "no experience required", recent graduate → entry
   - ~2-5 years, established individual contributor → mid
   - 5+ years, "extensive experience", deep domain expertise, owns large/complex systems → senior
   - manages a team, hires, owns headcount → lead

3) TIE-BREAKERS: a "senior" modifier on a manager title (e.g. "Senior Engineering Manager") → senior. "Lead Intern" → internship.

4) PEOPLE-MANAGEMENT GATE: only choose "lead" or "executive" when the title or description shows managing people / a team / headcount, OR an explicit VP/Director/Chief/Head-of-org title. A qualified or licensed individual contributor (e.g. Counsel, Surveyor, Nurse, Therapist, Accountant, Engineer) is mid or senior based on experience — NOT lead/executive — unless it shows people management.

5) LANGUAGE: titles and descriptions may be in any language (French, German, Spanish, Portuguese, Italian, Dutch, etc.). Apply the same logic regardless of language. Recognize numeric seniority suffixes (I / II / III → entry/mid) and local seniority words (e.g. Junior, Senior, Lead, Responsable, Chef d'équipe, Leiter, Gerente, Jefe) in any language.

6) Only if NEITHER the title NOR the description gives any seniority signal, default to mid. Use "unknown" only when the title is genuinely empty, a placeholder/template, or pure gibberish.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'experience_levels',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['classifications'],
      properties: {
        classifications: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'level'],
            properties: {
              ref: { type: 'integer' },
              level: { type: 'string', enum: [...LEVELS, 'unknown'] },
            },
          },
        },
      },
    },
  },
};

function buildUserPayload(jobs) {
  // jobs: [{ ref, title, description }]
  const items = jobs.map(j => ({
    ref: j.ref,
    title: (j.title || '').slice(0, 200),
    description: (j.description || '').replace(/\s+/g, ' ').slice(0, DESC_CHARS),
  }));
  return `Classify each job. Return one entry per ref.\n\n${JSON.stringify(items)}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Transient network / connection errors worth retrying (fetch + pg). undici wraps the
// real errno in err.cause.code, so check message, code, and cause.code.
const TRANSIENT = /EADDRNOTAVAIL|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|other side closed|fetch failed|network|not queryable|connection|terminat|timeout/i;
function isTransient(err) {
  if (!err) return false;
  return err.name === 'TimeoutError' || err.retryable === true ||
    TRANSIENT.test(err.message || '') || TRANSIENT.test(err.code || '') || TRANSIENT.test(err.cause?.code || '');
}

let usageIn = 0, usageOut = 0;

async function callOpenAI(jobs, attempt = 0) {
  const key = process.env.OPENAI_API_KEY;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: Math.max(256, REQ_BATCH * 24),
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPayload(jobs) },
        ],
      }),
    });

    if (res.status === 429 || res.status >= 500) {
      throw Object.assign(new Error(`OpenAI HTTP ${res.status}`), { retryable: true });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${t.slice(0, 300)}`);
    }

    const data = await res.json();
    if (data.usage) { usageIn += data.usage.prompt_tokens || 0; usageOut += data.usage.completion_tokens || 0; }
    const content = data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    const out = [];
    for (const c of parsed.classifications || []) {
      if (ALLOWED.has(c.level)) out.push({ ref: c.ref, level: c.level });
    }
    return out;
  } catch (err) {
    if (isTransient(err) && attempt < 7) {
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      return callOpenAI(jobs, attempt + 1);
    }
    throw err;
  }
}

async function newClient(retries = 12) {
  let attempt = 0;
  while (true) {
    try {
      const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
      c.on('error', () => {});
      await c.connect();
      return c;
    } catch (e) {
      // DNS / socket blips while (re)connecting — back off and retry instead of dying.
      if (attempt++ < retries && isTransient(e)) {
        await sleep(Math.min(20000, 1000 * 2 ** attempt));
        continue;
      }
      throw e;
    }
  }
}

(async () => {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  if (!process.env.DB_URL) { console.error('DB_URL not set (e.g. DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board))'); process.exit(1); }

  let c = await newClient();
  async function query(sql, params) {
    let attempts = 0;
    while (true) {
      try { return await c.query(sql, params); }
      catch (e) {
        if (isTransient(e) && ++attempts < 8) {
          try { await c.end(); } catch {}
          await sleep(Math.min(15000, 1000 * 2 ** attempts));
          c = await newClient();
          continue;
        }
        throw e;
      }
    }
  }

  const titleClause = TITLE_LIKE ? ` AND title ILIKE '%${TITLE_LIKE.replace(/'/g, "''")}%'` : '';
  const TARGET = `removed_at IS NULL
      AND (experience_level IS NULL OR experience_level = '')
      AND description IS NOT NULL AND description <> ''${titleClause}`;

  const { rows: [{ total }] } = await query(`SELECT COUNT(*)::int AS total FROM jobs WHERE ${TARGET}`);
  const goal = LIMIT > 0 ? Math.min(LIMIT, total) : total;
  console.log(`Target unclassified (live, has description): ${total.toLocaleString()}${LIMIT ? ` — capped to ${goal.toLocaleString()}` : ''}`);
  console.log(`Model=${MODEL} readBatch=${READ_BATCH} reqBatch=${REQ_BATCH} concurrency=${CONCURRENCY} dryRun=${DRY_RUN}\n`);
  if (goal === 0) { await c.end(); return; }

  const tally = Object.fromEntries([...LEVELS, 'unknown'].map(l => [l, 0]));
  let processed = 0, updated = 0, errors = 0;
  let samplesPrinted = 0;
  const SAMPLE_CAP = DRY_RUN ? 60 : 0;
  let lastId = 0;
  const startedAt = Date.now();

  while (processed < goal) {
    const remaining = goal - processed;
    const pageSize = RANDOM ? goal : Math.min(READ_BATCH, remaining);
    const { rows } = RANDOM
      ? await query(`SELECT id, title, description FROM jobs WHERE ${TARGET} ORDER BY random() LIMIT $1`, [pageSize])
      : await query(`SELECT id, title, description FROM jobs WHERE id > $1 AND ${TARGET} ORDER BY id LIMIT $2`, [lastId, pageSize]);
    if (rows.length === 0) break;
    if (!RANDOM) lastId = rows[rows.length - 1].id;

    // Split the page into request-sized chunks, run CONCURRENCY at a time.
    const chunks = [];
    for (let i = 0; i < rows.length; i += REQ_BATCH) chunks.push(rows.slice(i, i + REQ_BATCH));

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const wave = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(wave.map(async (chunk) => {
        const refMap = new Map(chunk.map((j, idx) => [idx + 1, j.id]));
        const payload = chunk.map((j, idx) => ({ ref: idx + 1, title: j.title, description: j.description }));
        try {
          const labels = await callOpenAI(payload);
          const updates = [];
          for (const { ref, level } of labels) {
            const id = refMap.get(ref);
            if (!id) continue;
            tally[level]++;
            if (DRY_RUN && samplesPrinted < SAMPLE_CAP) {
              samplesPrinted++;
              console.log(`  ${level.padEnd(11)} ← ${(chunk[ref - 1]?.title || '').slice(0, 80)}`);
            }
            if (level !== 'unknown') updates.push({ id, level });
          }
          return updates;
        } catch (err) {
          errors += chunk.length;
          console.error(`  chunk failed (${chunk.length} jobs): ${err.message}`);
          return [];
        }
      }));

      const flat = results.flat();
      if (flat.length && !DRY_RUN) {
        // Batched UPDATE ... FROM (VALUES ...)
        const vals = [];
        const tuples = flat.map((u, k) => {
          vals.push(u.id, u.level);
          return `($${k * 2 + 1}::int, $${k * 2 + 2}::text)`;
        }).join(',');
        await query(
          `UPDATE jobs AS j SET experience_level = v.level
           FROM (VALUES ${tuples}) AS v(id, level)
           WHERE j.id = v.id`,
          vals
        );
      }
      updated += flat.length;
      processed += wave.reduce((s, ch) => s + ch.length, 0);
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = processed / elapsed;
    const eta = rate > 0 ? Math.round((goal - processed) / rate) : 0;
    const cost = (usageIn / 1e6) * PRICE_IN + (usageOut / 1e6) * PRICE_OUT;
    console.log(
      `${processed.toLocaleString()}/${goal.toLocaleString()} (${(processed / goal * 100).toFixed(1)}%) | ` +
      `updated ${updated.toLocaleString()} | err ${errors} | ${rate.toFixed(0)}/s | ETA ${Math.floor(eta / 60)}m | ` +
      `~$${cost.toFixed(2)} | ` + LEVELS.map(l => `${l[0]}${l[1]}:${tally[l]}`).join(' ') + ` un:${tally.unknown}`
    );
    if (RANDOM) break; // single diverse page; random() doesn't advance the id keyset
  }

  const cost = (usageIn / 1e6) * PRICE_IN + (usageOut / 1e6) * PRICE_OUT;
  console.log(`\nDone. processed=${processed} updated=${updated} errors=${errors} unknown=${tally.unknown}`);
  console.log(`Level tally: ${LEVELS.map(l => `${l}=${tally[l]}`).join(', ')}`);
  console.log(`Tokens: in=${usageIn.toLocaleString()} out=${usageOut.toLocaleString()} | est cost ~$${cost.toFixed(2)}${DRY_RUN ? ' (DRY_RUN — no DB writes)' : ''}`);
  await c.end();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
