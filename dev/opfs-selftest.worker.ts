// Dev-only self-test of the browser-only pieces: OpfsStore and zipStore in a worker.
// Open /dev/opfs-selftest.html on the dev server. Uses fake files; touches no Garmin data
// except that it clears the export store (same as "Discard").

import { unzipSync, strFromU8 } from 'fflate';
import { OpfsStore } from '../src/web/opfs-store';
import { zipStore } from '../src/core/zip';
import { writeJson, writeText, readJson } from '../src/core/store';

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

try {
  const store = await OpfsStore.open();
  await store.clear();
  check('starts empty after clear', (await store.list()).length === 0);

  const fit = new Uint8Array(200_000).map((_, i) => i % 251);
  fit.set([14, 16, 0, 0, 0, 0, 0, 0, 46, 70, 73, 84]); // ".FIT" at byte 8
  await store.write('activities/files/2026-01-01_Run_1.fit', fit);
  await writeText(store, 'wellness/sleep.csv', '﻿calendarDate,x\r\n2026-01-01,1\r\n');
  await writeJson(store, 'raw/hrv/2026-01-01_2026-12-31.json', { hrvSummaries: [{ calendarDate: '2026-01-01' }] });
  await writeJson(store, 'job.json', { activities: true, datasets: [] });

  check('has() finds a nested file', await store.has('activities/files/2026-01-01_Run_1.fit'));
  check('has() is false for a missing file', !(await store.has('raw/nope.json')));
  const listed = (await store.list()).sort();
  check('list() walks subfolders', listed.length === 4, listed.join(' '));
  check('read() returns what was written', (await store.read('activities/files/2026-01-01_Run_1.fit')).length === 200_000);
  check('readJson round-trips', (await readJson<{ hrvSummaries: unknown[] }>(store, 'raw/hrv/2026-01-01_2026-12-31.json')).hrvSummaries.length === 1);

  await store.write('wellness/sleep.csv', new TextEncoder().encode('short'));
  check('overwrite truncates', (await store.read('wellness/sleep.csv')).length === 5);

  const sink = await store.openOutput('test.zip');
  const paths = listed.filter((p) => p !== 'job.json');
  const blob = await zipStore(store, paths, 'root/', sink, () => {});
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  check('zip has every file under root/', Object.keys(entries).length === 3 && Object.keys(entries).every((n) => n.startsWith('root/')), Object.keys(entries).join(' '));
  check('zipped .fit is intact', strFromU8(entries['root/activities/files/2026-01-01_Run_1.fit'].subarray(8, 12)) === '.FIT');
  check('zip output is not in the export store', !(await store.list()).some((p) => p.endsWith('.zip')));

  await store.clear();
  check('clear() empties the store', (await store.list()).length === 0);
} catch (e) {
  check('no exception', false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
}

(self as unknown as Worker).postMessage(checks);
