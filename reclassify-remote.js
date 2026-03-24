/**
 * Reclassify all remote_worldwide=true jobs using LLM only.
 * Run: heroku run node reclassify-remote.js --app fastapply-board
 */
const { query } = require('./src/db/connection');
const config = require('./src/config');
const HF_MODEL = 'Qwen/Qwen2.5-72B-Instruct';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';

const SYSTEM_PROMPT = `You classify job postings. Return ONLY a single valid JSON object. No markdown, no explanation, no extra text.`;

function buildUserPrompt(job) {
  const desc = (job.description || '').substring(0, 1000);
  return `Title: ${job.title || 'Not specified'}
Location: ${job.location || 'Not specified'}
Workplace type: ${job.workplace_type || 'Not specified'}
Description: ${desc}

Classify remote work ONLY. Return JSON:
{"is_remote":bool,"remote_worldwide":bool}

Rules:
- is_remote: true if the job can be performed remotely (not on-site only)
- remote_worldwide: true ONLY if explicitly states worldwide/global/anywhere with NO country or region restriction
- "Remote" alone is NOT worldwide
- "Remote - US" or "Remote - Europe" is NOT worldwide
- "Anywhere in Latin America" is NOT worldwide
- "Remote in [specific country/region]" is NOT worldwide
- ONLY mark worldwide if the posting says something like "work from anywhere in the world", "global remote", "worldwide", with zero geographic restrictions`;
}

function parseResponse(content) {
  if (!content) return null;
  const cleaned = content.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.is_remote !== 'boolean') return null;
    if (typeof parsed.remote_worldwide !== 'boolean') return null;
    return parsed;
  } catch { return null; }
}

async function classify(job) {
  const token = config.HF_API_TOKEN;
  if (!token) throw new Error('No HF_API_TOKEN');

  const res = await fetch(HF_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(job) },
      ],
      max_tokens: 30,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`HF ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  return parseResponse(data.choices?.[0]?.message?.content);
}

async function main() {
  const { rows: jobs } = await query(
    `SELECT id, title, description, location, workplace_type FROM jobs WHERE remote_worldwide = true`
  );

  console.log(`Found ${jobs.length} jobs marked remote_worldwide=true to reclassify\n`);

  let changed = 0, kept = 0, failed = 0;
  const CONCURRENCY = 5;

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (job) => {
      try {
        const result = await classify(job);
        if (!result) { failed++; return; }

        if (!result.remote_worldwide) {
          await query(`UPDATE jobs SET is_remote = ?, remote_worldwide = false WHERE id = ?`, [result.is_remote, job.id]);
          const tag = result.is_remote ? 'REMOTE' : 'ONSITE';
          console.log(`  [${tag.padEnd(7)}] ${job.title.substring(0, 60)}`);
          changed++;
        } else {
          kept++;
        }
      } catch (err) {
        console.error(`  [FAIL] ${job.title.substring(0, 40)}: ${err.message.substring(0, 80)}`);
        failed++;
      }
    }));

    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= jobs.length) {
      console.log(`\n  Progress: ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} (changed=${changed}, kept=${kept}, failed=${failed})\n`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${changed} changed, ${kept} confirmed worldwide, ${failed} failed out of ${jobs.length}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
