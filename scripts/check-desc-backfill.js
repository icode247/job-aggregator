const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  const { rows: desc } = await query(
    `SELECT
      COUNT(*) FILTER (WHERE description IS NOT NULL AND description != '') as with_desc,
      COUNT(*) FILTER (WHERE description IS NULL OR description = '') as without_desc,
      COUNT(*) as total
    FROM jobs WHERE removed_at IS NULL`
  );
  console.log('=== Description Coverage ===');
  console.log('With description:', desc[0].with_desc);
  console.log('Without description:', desc[0].without_desc);
  console.log('Total active:', desc[0].total);
  console.log('Coverage:', (100 * desc[0].with_desc / desc[0].total).toFixed(1) + '%');

  const { rows: byAts } = await query(
    `SELECT ats,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE description IS NOT NULL AND description != '') as with_desc,
      COUNT(*) FILTER (WHERE description IS NULL OR description = '') as without_desc
    FROM jobs WHERE removed_at IS NULL
    GROUP BY ats ORDER BY without_desc DESC`
  );
  console.log('\n=== By ATS ===');
  for (const r of byAts) {
    const pct = r.total > 0 ? (100 * r.with_desc / r.total).toFixed(1) : '0.0';
    console.log(`  ${r.ats}: ${r.with_desc}/${r.total} have desc (${pct}%), ${r.without_desc} missing`);
  }

  // Also check visa classification progress
  const { rows: visa } = await query(
    `SELECT visa_sponsorship, COUNT(*) as cnt
     FROM jobs WHERE removed_at IS NULL
     GROUP BY visa_sponsorship ORDER BY cnt DESC`
  );
  console.log('\n=== Visa Classification ===');
  for (const r of visa) {
    console.log(`  ${r.visa_sponsorship === null ? 'NULL (unclassified)' : r.visa_sponsorship === '' ? '(no match)' : r.visa_sponsorship}: ${r.cnt}`);
  }

  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
