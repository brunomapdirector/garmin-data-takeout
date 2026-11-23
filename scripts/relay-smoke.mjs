// Smoke test for the relay against a running dev server.
//
//   npm run dev      (in one terminal)
//   npm run smoke    (in another; reads GARMIN_API_KEY from the environment or .garmin-api-key)
//
// Checks the relay's refusals without a key, then one real token exchange, one data
// call and one file download. Prints statuses only, never the key or token.

import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.RELAY ?? 'http://localhost:5173';
let key = process.env.GARMIN_API_KEY;
if (!key && existsSync('.garmin-api-key')) key = readFileSync('.garmin-api-key', 'utf8').match(/GARMIN_API_KEY\s*=\s*(\S+)/)?.[1];

let failures = 0;
async function expect(label, want, url, init) {
  const res = await fetch(BASE + url, init);
  const ok = Array.isArray(want) ? want.includes(res.status) : res.status === want;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${res.status} (want ${want})`);
  return res;
}

// Refusals (no key needed)
await expect('unknown api path', 404, '/api/nope');
await expect('path not on allow-list', 404, '/api/garmin/userprofile-service/socialProfile', { headers: { Authorization: 'Bearer x' } });
await expect('traversal attempt', 404, '/api/garmin/userprofile-service/userprofile/settings/..%2F..%2Fx', { headers: { Authorization: 'Bearer x' } });
await expect('token via GET', 405, '/api/token');
await expect('token without ApiKey header', 400, '/api/token', { method: 'POST' });
await expect('data without Bearer', 401, '/api/garmin/userprofile-service/userprofile/settings');
await expect('other website (Origin)', 403, '/api/garmin/userprofile-service/userprofile/settings', {
  headers: { Authorization: 'Bearer x', Origin: 'https://evil.example' },
});
await expect('other website (Sec-Fetch-Site)', 403, '/api/token', {
  method: 'POST', headers: { Authorization: 'ApiKey x', 'Sec-Fetch-Site': 'cross-site' },
});
await expect('static site still served', 200, '/');

if (!key) {
  console.log('\nNo GARMIN_API_KEY: skipped the live calls.');
} else {
  const t = await expect('token exchange', 200, '/api/token', { method: 'POST', headers: { Authorization: `ApiKey ${key}` } });
  const token = (await t.text()).trim();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const p = await expect('profile through relay', 200, '/api/garmin/userprofile-service/userprofile/settings', auth);
  console.log(`     cache-control: ${p.headers.get('cache-control')}`);
  const l = await expect('activity list through relay', 200, '/api/garmin/activitylist-service/activities/search/activities?start=0&limit=1&sortOrder=desc', auth);
  const [newest] = await l.json();
  if (newest) {
    const f = await expect('activity file through relay', 200, `/api/garmin/download-service/files/activity/${newest.activityId}`, auth);
    console.log(`     ${f.headers.get('content-type')}, ${(await f.arrayBuffer()).byteLength} bytes`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
