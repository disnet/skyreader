// Driver for the search-index spike. Seeds each variant's DO, then times
// ranked queries from outside (HTTP round trip to local workerd) and inside
// the DO (performance.now around the SQL). Usage: node bench.mjs [docs]
const BASE = process.env.SPIKE_URL ?? 'http://127.0.0.1:8799';
const N = Number(process.argv[2] ?? 50_000);
const BATCH = 1_000;
const VARIANTS = (process.env.VARIANTS ?? 'ext,less,ext_col').split(',');
const RUNS = 15;

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const t0 = performance.now();
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error}`);
  return { body, rtt: performance.now() - t0 };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mb = (b) => (b / 1024 / 1024).toFixed(1);

// Terms at chosen Zipf ranks: 5 = in nearly every doc, 200 = common,
// 3000 = mid, 20000 = rare.
const [w5, w50, w200, w3000, w20000, w20001] = (
  await get('/vocab', { ranks: '5,50,200,3000,20000,20001' })
).body;

const QUERIES = [
  { name: 'very common term', q: w5 },
  { name: 'common term', q: w200 },
  { name: 'mid term', q: w3000 },
  { name: 'rare term', q: w20000 },
  { name: 'two terms AND', q: `${w200} ${w3000}` },
  { name: 'three terms AND', q: `${w50} ${w200} ${w3000}` },
  { name: 'phrase', q: `"${w50} ${w200}"` },
  { name: 'prefix', q: `${w3000.slice(0, 3)}*` },
  { name: 'title column', q: `title:${w3000}` },
  { name: 'notes column', q: `notes:${w200}` },
  { name: 'OR of rare', q: `${w20000} OR ${w20001}` },
  { name: 'common + saved only', q: w200, kind: 2 },
  { name: 'common + last 90 days', q: w200, since: 1_793_000_000_000 - 90 * 86_400_000 },
];

const report = { docs: N, variants: {} };
for (const variant of VARIANTS) {
  const user = `bench-${variant}-${N}`;
  const before = (await get('/info', { user, variant })).body;
  console.log(`\n== ${variant} (SQLite ${before.sqliteVersion})`);
  let seedMs = 0;
  let textBytes = 0;
  let rowsWritten = 0;
  if (before.docs < N) {
    for (let start = before.docs; start < N; start += BATCH) {
      const { body } = await get('/seed', {
        user,
        variant,
        start,
        count: Math.min(BATCH, N - start),
      });
      seedMs += body.ms;
      textBytes += body.textBytes;
      rowsWritten += body.rowsWritten;
      if ((start / BATCH) % 10 === 0) process.stdout.write(`  seeded ${start + BATCH}\r`);
    }
  }
  const seeded = (await get('/info', { user, variant })).body;
  const opt = (await get('/optimize', { user, variant })).body;
  console.log(
    `  docs ${seeded.docs}, text ${mb(textBytes)} MB, db ${mb(seeded.databaseSize)} MB, ` +
      `after optimize ${mb(opt.databaseSize)} MB (optimize ${opt.ms.toFixed(0)} ms), ` +
      `seed ${(seedMs / 1000).toFixed(1)} s (${((N / seedMs) * 1000).toFixed(0)} docs/s), ` +
      `billed rows written ${(rowsWritten / Math.max(1, N - before.docs)).toFixed(1)}/doc`
  );
  const v = {
    textMB: textBytes / 1048576,
    dbMB: opt.databaseSize / 1048576,
    seedDocsPerSec: (N / seedMs) * 1000,
    queries: {},
  };
  for (const qd of QUERIES) {
    const inner = [];
    const rtts = [];
    let matches = 0;
    let rowsRead = 0;
    let err = null;
    for (let i = 0; i < RUNS; i++) {
      try {
        const { body, rtt } = await get('/query', {
          user,
          variant,
          q: qd.q,
          kind: qd.kind ?? 0,
          since: qd.since ?? 0,
          limit: 20,
        });
        inner.push(body.ms);
        rtts.push(rtt);
        matches = body.matches;
        rowsRead = body.rowsRead;
      } catch (e) {
        err = String(e.message).slice(0, 80);
        break;
      }
    }
    if (err) {
      console.log(`  ${qd.name.padEnd(24)} ERROR ${err}`);
      v.queries[qd.name] = { error: err };
      continue;
    }
    const row = {
      matches,
      rowsRead,
      p50: pct(inner, 50),
      p95: pct(inner, 95),
      rttP95: pct(rtts, 95),
    };
    v.queries[qd.name] = row;
    console.log(
      `  ${qd.name.padEnd(24)} ${String(matches).padStart(6)} hits  p50 ${row.p50.toFixed(1).padStart(6)} ms  p95 ${row.p95.toFixed(1).padStart(6)} ms  rtt p95 ${row.rttP95.toFixed(1).padStart(6)} ms  rows read ${rowsRead}`
    );
  }
  const m = (await get('/mutate', { user, variant })).body;
  console.log(
    `  delete check: fts rows left for deleted id = ${m.ftsRowsLeft}, delete cost ${JSON.stringify(m.deleteCost)}`
  );
  v.deleteOk = m.ftsRowsLeft === 0;
  report.variants[variant] = v;
}
await import('node:fs').then((fs) =>
  fs.writeFileSync(`results-${N}.json`, JSON.stringify(report, null, 2))
);
