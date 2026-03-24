/**
 * Reclassify all visa_sponsorship='yes' jobs using LLM only (no regex fallback).
 * Run: heroku run node reclassify-visa.js --app fastapply-board
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
Description: ${desc}

Classify visa_sponsorship ONLY. Return JSON:
{"visa_sponsorship":"yes"|"no"|"unknown"}

Rules:
- "yes" ONLY if the employer explicitly states they will sponsor, provide, or offer work visas/permits (H1B, work permit, immigration sponsorship)
- "no" if they explicitly say they do NOT sponsor or require existing authorization
- "unknown" if visa/sponsorship is not mentioned at all
- IMPORTANT: Simply mentioning "visa" or "sponsorship" in passing is NOT enough for "yes". The employer must be OFFERING sponsorship.
- "authorized to work" requirements = "no" (they want existing authorization, not offering sponsorship)`;
}

function parseResponse(content) {
  if (!content) return null;
  const cleaned = content.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!['yes', 'no', 'unknown'].includes(parsed.visa_sponsorship)) return null;
    return parsed.visa_sponsorship;
  } catch { return null; }
}

async function classifyVisa(job) {
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
    `SELECT id, title, description, location FROM jobs WHERE visa_sponsorship = 'yes'`
  );

  console.log(`Found ${jobs.length} jobs marked visa_sponsorship=yes to reclassify\n`);

  let changed = 0, kept = 0, failed = 0;
  const CONCURRENCY = 5;

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (job) => {
      try {
        const result = await classifyVisa(job);
        if (!result) { failed++; return; }

        const newValue = result === 'unknown' ? '' : result;
        if (newValue !== 'yes') {
          await query(`UPDATE jobs SET visa_sponsorship = ? WHERE id = ?`, [newValue, job.id]);
          console.log(`  [${result.toUpperCase().padEnd(7)}] ${job.title.substring(0, 60)}`);
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

    // Small delay between batches to respect rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${changed} changed, ${kept} confirmed yes, ${failed} failed out of ${jobs.length}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
