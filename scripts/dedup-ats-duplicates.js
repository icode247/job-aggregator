#!/usr/bin/env node
/**
 * Dedup every ATS the way the Workday/Greenhouse passes did: rows sharing (ats, ats_slug)
 * resolve to one board at crawl time, so extra rows re-crawl it and re-insert its postings
 * under a second company_id.
 *
 * Slugs that are generic URL path segments ("company", "jobs", "careersection") are
 * EXCLUDED. Those groups are not duplicates — they are distinct companies whose slug was
 * mis-extracted, the same defect found in jazzhr ("apply") and oraclecloud ("hcmUI").
 * Deduping them would merge unrelated companies and destroy real boards.
 *
 * Survivor = most live jobs, then lowest id. Rows are deactivated, never deleted, and only
 * postings currently live under the survivor are removed — anything unique to a retired
 * row is left for scripts/prune-dead-jobs-local.js, which does not filter on company status.
 *
 *   DRY=1 node scripts/dedup-ats-duplicates.js    # report only
 *   node scripts/dedup-ats-duplicates.js          # write
 *
 * Re-runnable, and worth re-running: the demand feeds (wonsulting/liftmycv/lazyapply/
 * jobhose) keep seeding rows for boards already crawled, so duplicates reaccumulate.
 */
const fs=require('fs');
const {query,closeDb}=require('../src/db/connection');
const DRY=process.env.DRY==='1';
const G="^(company|companies|jobs|job|job-openings|career|careers|careersection|opportunities|positions|openings|talent|people|team|about|home|index|search|apply|hiring|main|portal|site|page|default|external|internal|psc|en|us|www|vacancies|listings)$";
(async()=>{
  // Postgres-only: the generic-slug filter uses the `!~` regex operator.
  if(!process.env.DATABASE_URL){ console.error('Set DATABASE_URL (Postgres required)'); process.exit(1); }
  const {rows}=await query(`
    SELECT c.id, c.ats, LOWER(c.ats_slug) s, c.company_name,
           (SELECT COUNT(*) FROM jobs j WHERE j.company_id=c.id AND j.removed_at IS NULL) live
      FROM companies c
     WHERE c.status='active' AND c.ats IS NOT NULL AND c.ats_slug IS NOT NULL
       AND LOWER(c.ats_slug) !~ $1
       AND (c.ats, LOWER(c.ats_slug)) IN (
         SELECT ats, LOWER(ats_slug) FROM companies
          WHERE status='active' AND ats IS NOT NULL AND ats_slug IS NOT NULL
            AND LOWER(ats_slug) !~ $1
          GROUP BY 1,2 HAVING COUNT(*)>1)`,[G]);
  const groups=new Map();
  for(const r of rows){ r.live=Number(r.live); const k=r.ats+'|'+r.s;
    if(!groups.has(k))groups.set(k,[]); groups.get(k).push(r); }
  const losers=[],keeperOf={};
  for(const [k,g] of groups){
    g.sort((a,b)=>b.live-a.live||a.id-b.id);
    keeperOf[k]=g[0].id; losers.push(...g.slice(1).map(r=>({...r,k})));
  }
  const perAts={};
  losers.forEach(l=>perAts[l.ats]=(perAts[l.ats]||0)+1);
  console.log('groups:',groups.size,'| redundant rows:',losers.length);
  console.table(Object.entries(perAts).map(([ats,n])=>({ats,redundant:n})).sort((a,b)=>b.redundant-a.redundant));
  console.log('live jobs on redundant rows:',losers.reduce((s,r)=>s+r.live,0));

  let ids=[];
  for(let i=0;i<losers.length;i+=1000){
    const c=losers.slice(i,i+1000);
    const {rows:o}=await query(
      `SELECT j.id FROM jobs j
         JOIN (SELECT unnest($1::int[]) l, unnest($2::int[]) k) v ON j.company_id=v.l
         JOIN jobs s ON s.company_id=v.k AND s.external_id=j.external_id AND s.removed_at IS NULL
        WHERE j.removed_at IS NULL`,[c.map(r=>r.id),c.map(r=>keeperOf[r.k])]);
    ids=ids.concat(o.map(r=>r.id));
    process.stderr.write(`  overlap ${Math.min(i+1000,losers.length)}/${losers.length} -> ${ids.length}\n`);
  }
  console.log('duplicate live postings (also live under survivor):',ids.length);
  fs.writeFileSync(process.env.PLAN_OUT||'/tmp/ats-dedup-plan.json',JSON.stringify({losers:losers.map(l=>({id:l.id,ats:l.ats,s:l.s,k:l.k})),keeperOf}));
  if(DRY){await closeDb();return}

  let jobs=0;
  for(let i=0;i<ids.length;i+=5000)
    jobs+=(await query('UPDATE jobs SET removed_at=NOW() WHERE id=ANY($1::int[]) AND removed_at IS NULL',[ids.slice(i,i+5000)])).rowCount;
  console.log('postings marked removed:',jobs);
  let comp=0;
  for(let i=0;i<losers.length;i+=200){
    const s=losers.slice(i,i+200);
    const v=s.map((_,k)=>`($${k*2+1}::int,$${k*2+2}::text)`).join(',');
    comp+=(await query(`UPDATE companies SET status='inactive', error_message=v.msg, updated_at=NOW()
       FROM (VALUES ${v}) AS v(id,msg) WHERE companies.id=v.id`,
      s.flatMap(l=>[l.id,`duplicate ${l.ats} board "${l.s}" — superseded by company #${keeperOf[l.k]}`]))).rowCount;
  }
  console.log('companies retired:',comp);
  await closeDb();
})().catch(e=>{console.error(e.message);process.exit(1)});
