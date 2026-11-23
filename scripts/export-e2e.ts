// End-to-end check of the export code the page runs, from Node, through the local relay.
//
//   npm run dev                      (one terminal)
//   npx tsx scripts/export-e2e.ts    (another; key from GARMIN_API_KEY or .garmin-api-key)
//
// Writes the zip to exports/ (gitignored) and prints what is inside: counts and names,
// never the key, token or data values.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { runExport } from '../src/core/export';

const relay = process.env.RELAY ?? 'http://localhost:5173';
let key = process.env.GARMIN_API_KEY;
if (!key && existsSync('.garmin-api-key')) key = readFileSync('.garmin-api-key', 'utf8').match(/GARMIN_API_KEY\s*=\s*(\S+)/)?.[1];
if (!key) throw new Error('No GARMIN_API_KEY');

const t0 = Date.now();
let last = '';
const result = await runExport({
  relay,
  key,
  onProgress: (p) => {
    const line = p.stage === 'files' ? (p.done % 25 === 0 || p.done === p.total ? `files ${p.done}/${p.total}` : '') : JSON.stringify(p);
    if (line && line !== last) console.log(' ', line);
    last = line || last;
  },
});
const zip = new Uint8Array(await result.blob.arrayBuffer());
mkdirSync('exports', { recursive: true });
writeFileSync(`exports/${result.fileName}`, zip);

const entries = unzipSync(zip);
const names = Object.keys(entries);
const fit = names.filter((n) => n.includes('/activities/files/'));
const csv = strFromU8(entries[names.find((n) => n.endsWith('activities.csv'))!]).replace(/^﻿/, '').trim().split('\r\n');
const fitHeaderOk = fit.filter((n) => n.endsWith('.fit')).every((n) => strFromU8(entries[n].subarray(8, 12)) === '.FIT');

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${result.activities} activities, ${(zip.length / 1e6).toFixed(1)} MB, ${names.length} entries`);
console.log(`  activity files: ${fit.length} (extensions: ${[...new Set(fit.map((n) => n.split('.').pop()))].join(', ')}), all .fit headers valid: ${fitHeaderOk}`);
console.log(`  activities.csv: ${csv.length - 1} rows, columns: ${csv[0]}`);
console.log(`  example file name: ${fit[0]?.split('/').pop()}`);
console.log(`  failed: ${result.failed.length}`);
