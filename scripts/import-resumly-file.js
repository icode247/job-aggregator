#!/usr/bin/env node
/**
 * Batch-import a resumly JSONL dump (from fetch-resumly-bulk.js FETCH_FILE mode) into Postgres.
 * No resumly token needed — decoupled from the token-bound fetch. Multi-row upserts (companies
 * then jobs) make this far faster than per-job round-trips. Resumable via a line-offset checkpoint.
 *
 * Run: FETCH_FILE=/tmp/resumly-jobs.jsonl DATABASE_URL=... node scripts/import-resumly-file.js
 * Env: IMPORT_BATCH(500) IMPORT_OFFSET_FILE(/tmp/resumly-import.offset)
 */
const fs = require('fs');
const readline = require('readline');
const { deriveCompany } = require('../src/tasks/demand-crawl');
const { query, closeDb } = require('../src/db/connection');
const { classifyJob } = require('../src/utils/classify');
const logger = require('../src/logger');

const FILE = process.env.FETCH_FILE || '/tmp/resumly-jobs.jsonl';
const BATCH = parseInt(process.env.IMPORT_BATCH || '500', 10);
const OFFSET_FILE = process.env.IMPORT_OFFSET_FILE || '/tmp/resumly-import.offset';

async function flush(batch) {
  if (!batch.length) return 0;
  // 1) derive + batch-upsert companies (dedup by career_url within the batch)
  const derived = batch.map((n) => ({ n, c: deriveCompany(n.applyUrl, n.atsHint, n.company, 'resumly') }))
    .filter((x) => x.c.slug && x.c.careerUrl);
  const uniqCos = new Map();
  for (const { n, c } of derived) if (!uniqCos.has(c.careerUrl)) uniqCos.set(c.careerUrl, { name: n.company, domain: c.domain, ats: c.ats, slug: c.slug, careerUrl: c.careerUrl });
  const cos = [...uniqCos.values()];
  if (!cos.length) return 0;
  const cVals = []; const cParams = [];
  cos.forEach((c, i) => { const b = i * 6; cVals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'active',$${b + 6},NOW(),NOW())`); cParams.push(c.name, c.domain, c.ats, c.slug, c.careerUrl, 'demand_resumly'); });
  const cRes = await query(
    `INSERT INTO companies (company_name,domain,ats,ats_slug,career_url,status,origin,created_at,updated_at)
       VALUES ${cVals.map((v) => v.replace("'active'", "'active'")).join(',')}
     ON CONFLICT (career_url) DO UPDATE SET company_name=COALESCE(companies.company_name,EXCLUDED.company_name), updated_at=NOW()
     RETURNING id, career_url`, cParams);
  const idByUrl = new Map(cRes.rows.map((r) => [r.career_url, r.id]));

  // 2) batch-upsert jobs
  const jVals = []; const jParams = []; let k = 0;
  for (const { n, c } of derived) {
    const companyId = idByUrl.get(c.careerUrl);
    if (!companyId || !n.externalId) continue;
    const tags = classifyJob({ title: n.title, location: n.location, description: '', workplace_type: n.workplaceType }) || {};
    const b = k * 13; k++;
    jVals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},NOW(),NOW(),NOW())`);
    jParams.push(String(n.externalId), companyId, c.ats, n.title, n.location, n.workplaceType, null, n.jobUrl,
      n.postedAt, n.workplaceType === 'remote' || !!tags.is_remote, !!tags.remote_worldwide, tags.experience_level || null, JSON.stringify({ source: 'demand_resumly' }));
  }
  if (!jVals.length) return 0;
  const jRes = await query(
    `INSERT INTO jobs (external_id,company_id,ats,title,location,workplace_type,description,url,posted_at,is_remote,remote_worldwide,experience_level,raw_data,first_seen_at,last_seen_at,created_at)
       VALUES ${jVals.join(',')}
     ON CONFLICT (external_id, company_id) DO UPDATE SET location=EXCLUDED.location, url=EXCLUDED.url, last_seen_at=NOW(), removed_at=NULL
     RETURNING (xmax = 0) AS inserted`, jParams);
  return jRes.rows.filter((r) => r.inserted).length;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!fs.existsSync(FILE)) { console.error('No file: ' + FILE); process.exit(1); }
  let startLine = 0;
  try { startLine = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0; } catch { /* fresh */ }
  logger.info({ file: FILE, resumeFrom: startLine }, 'resumly import starting');

  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  let line = 0, batch = [], added = 0, processed = 0;
  const t0 = Date.now();
  for await (const raw of rl) {
    line++;
    if (line <= startLine) continue;
    let n; try { n = JSON.parse(raw); } catch { continue; }
    batch.push(n);
    if (batch.length >= BATCH) {
      try { added += await flush(batch); } catch (e) { logger.warn({ err: e.message, line }, 'batch flush failed — skip'); }
      processed += batch.length; batch = [];
      fs.writeFileSync(OFFSET_FILE, String(line));
      if (processed % 5000 === 0) logger.info({ line, added, rate: (processed / ((Date.now() - t0) / 1000)).toFixed(0) + '/s' }, 'import progress');
    }
  }
  if (batch.length) { try { added += await flush(batch); } catch (e) { logger.warn({ err: e.message }, 'final flush failed'); } fs.writeFileSync(OFFSET_FILE, String(line)); }
  logger.info({ processed: line - startLine, added, minutes: ((Date.now() - t0) / 60000).toFixed(1) }, 'resumly import COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'resumly import fatal'); process.exit(1); });
