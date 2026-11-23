// End-to-end check of the export code the page's worker runs, from Node, through the
// local relay, with a folder on disk as the store.
//
//   npm run dev                                  (one terminal)
//   npx tsx scripts/export-e2e.ts [--all] [--from yyyy-MM-dd] [--to yyyy-MM-dd]
//
// --all also fetches the slow per-day datasets. Run it twice: the second run resumes
// and should fetch nothing new. Store: exports/e2e-store/, zip: exports/. Prints counts
// and names only, never the key, token or data values.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { runExport } from '../src/core/export';
import { DATASETS } from '../src/core/datasets';
import type { ExportStore, OutputSink } from '../src/core/store';

class FsStore implements ExportStore {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  async write(p: string, d: Uint8Array) { mkdirSync(dirname(join(this.dir, p)), { recursive: true }); writeFileSync(join(this.dir, p), d); }
  async read(p: string) { return new Uint8Array(readFileSync(join(this.dir, p))); }
  async has(p: string) { return existsSync(join(this.dir, p)); }
  async list() {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(relative(this.dir, join(d, e.name)).replace(/\\/g, '/')); };
    walk(this.dir);
    return out;
  }
  async clear() { rmSync(this.dir, { recursive: true, force: true }); mkdirSync(this.dir, { recursive: true }); }
  async openOutput(name: string): Promise<OutputSink> {
    const path = join('exports', name);
    const fd = openSync(path, 'w');
    return { write: (c) => { writeSync(fd, c); }, close: async () => { closeSync(fd); return new Blob([readFileSync(path)]); } };
  }
}

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const relay = process.env.RELAY ?? 'http://localhost:5173';
let key = process.env.GARMIN_API_KEY;
if (!key && existsSync('.garmin-api-key')) key = readFileSync('.garmin-api-key', 'utf8').match(/GARMIN_API_KEY\s*=\s*(\S+)/)?.[1];
if (!key) throw new Error('No GARMIN_API_KEY');

mkdirSync('exports', { recursive: true });
const t0 = Date.now();
let last = '';
const result = await runExport({
  relay,
  key,
  store: new FsStore('exports/e2e-store'),
  from: arg('--from'),
  to: arg('--to'),
  activities: true,
  datasets: DATASETS.filter((d) => d.defaultOn || process.argv.includes('--all')).map((d) => d.id),
  onProgress: (p) => {
    const line =
      p.stage === 'step' ? (p.done === p.total || p.done % 50 === 0 ? `${p.id} ${p.done}/${p.total}` : '')
      : p.stage === 'zipping' ? (p.done === p.total ? `zipped ${p.total}` : '')
      : JSON.stringify(p);
    if (line && line !== last) console.log(' ', line);
    if (line) last = line;
  },
});

const zip = new Uint8Array(await result.blob.arrayBuffer());
const entries = unzipSync(zip);
const names = Object.keys(entries);
const by = (prefix: string) => names.filter((n) => n.split('/').slice(1).join('/').startsWith(prefix));
const fit = by('activities/files/');
const fitOk = fit.filter((n) => n.endsWith('.fit')).every((n) => strFromU8(entries[n].subarray(8, 12)) === '.FIT');

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${result.from} to ${result.to}, ${(zip.length / 1e6).toFixed(1)} MB, ${names.length} entries`);
console.log(`  activities: ${result.activities}, files: ${fit.length}, all .fit headers valid: ${fitOk}`);
for (const csv of by('wellness/')) {
  const lines = strFromU8(entries[csv]).replace(/^﻿/, '').trim().split('\r\n');
  const cols = lines[0].split(',');
  console.log(`  ${csv.split('/').pop()}: ${lines.length - 1} rows, ${cols.length} columns, first: ${cols.slice(0, 4).join(', ')}; dates ${lines[1]?.split(',')[0]} .. ${lines.at(-1)?.split(',')[0]}`);
}
const rawDirs = [...new Set(by('raw/').map((n) => n.split('/')[2]))];
console.log(`  raw/: ${by('raw/').length} files in ${rawDirs.join(', ')}`);
console.log(`  top level: ${[...new Set(names.map((n) => n.split('/')[1]))].join(', ')}`);
console.log(`  failed: ${result.failed.length}${result.failed.length ? ' ' + JSON.stringify(result.failed.slice(0, 5)) : ''}`);
