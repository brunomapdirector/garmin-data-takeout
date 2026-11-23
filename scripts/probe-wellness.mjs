// Phase 2 probe: response shapes and range limits of the wellness endpoints.
//   node scripts/probe-wellness.mjs
// Prints shapes (keys and types) and statuses only. Raw responses go to probe-out/.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://personal.connectapi.garmin.com';
const key = readFileSync('.garmin-api-key', 'utf8').match(/GARMIN_API_KEY\s*=\s*(\S+)/)[1];
mkdirSync('probe-out', { recursive: true });

const tok = await fetch(BASE + '/personalapitoken-service/personal-api/personal-api-key/token', {
  method: 'POST', headers: { Authorization: `ApiKey ${key}` },
});
const token = (await tok.text()).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

function shape(v, depth = 0, max = 4) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}] ${depth < max ? shape(v.find((x) => x !== null) ?? v[0], depth + 1, max) : '…'}` : '[0]';
  if (typeof v === 'object') {
    if (depth >= max) return '{…}';
    const pad = '  '.repeat(depth + 1);
    return '{\n' + Object.entries(v).map(([k, x]) => `${pad}${k}: ${shape(x, depth + 1, max)}`).join('\n') + '\n' + '  '.repeat(depth) + '}';
  }
  return typeof v === 'string' ? `string(${v.length})` : typeof v;
}

async function get(label, path, { showShape = true, file } = {}) {
  await sleep(500);
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  console.log(`\n[${label}] ${res.status} ${path}${res.status === 429 ? ' retry-after=' + res.headers.get('retry-after') : ''}`);
  if (!res.ok) { console.log('  body:', text.slice(0, 200)); return null; }
  let json; try { json = JSON.parse(text); } catch { console.log('  not json', text.length); return null; }
  if (file) writeFileSync(`probe-out/${file}`, JSON.stringify(json, null, 2));
  if (showShape) console.log('  ' + shape(json).replace(/\n/g, '\n  '));
  else console.log(`  ok, ${Array.isArray(json) ? json.length + ' items' : 'object'}`);
  return json;
}

// Shapes (one window each)
const ds = JSON.parse(readFileSync('probe-out/dailysummaries-last-year.json', 'utf8')).data;
console.log('[dailysummaries v2 item, from probe-out]\n  ' + shape(ds.at(-2), 0, 3).replace(/\n/g, '\n  '));

await get('stress 28d', `/usersummary-service/stats/stress/daily/${iso(28)}/${iso(1)}`, { file: 'stress-28d.json' });
await get('steps 28d', `/usersummary-service/stats/steps/daily/${iso(28)}/${iso(1)}`, { file: 'steps-28d.json' });
await get('body battery 31d', `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${iso(31)}&endDate=${iso(1)}`, { file: 'bb-31d.json' });
await get('hydration 31d', `/usersummary-service/stats/hydration/daily/${iso(31)}/${iso(1)}`, { file: 'hydration-31d.json' });
await get('weight all 364d', `/weight-service/weight/all/${iso(364)}/${iso(0)}`, { file: 'weight-364d.json' });
await get('vo2max 365d', `/metrics-service/metrics/maxmet/daily/${iso(365)}/${iso(0)}`, { file: 'vo2-365d.json' });
await get('fitness age today', `/fitnessage-service/fitnessage/v2/${iso(0)}`, { file: 'fitness-age.json' });
await get('hr zones', `/biometric-service/heartRateZones/v2`, { file: 'hr-zones.json' });
await get('wellness activity 31d', `/wellnessactivity-service/activity/summary/range/${iso(31)}/${iso(1)}`, { file: 'wellness-activity-31d.json' });

// Limits
await get('hrv 365d', `/hrv-service/hrv/daily/${iso(365)}/${iso(1)}`, { showShape: false });
await get('hrv 180d', `/hrv-service/hrv/daily/${iso(180)}/${iso(1)}`, { showShape: false });
await get('vo2max 730d', `/metrics-service/metrics/maxmet/daily/${iso(730)}/${iso(0)}`, { showShape: false });
await get('wellness activity 365d', `/wellnessactivity-service/activity/summary/range/${iso(365)}/${iso(1)}`, { showShape: false });
await get('steps 29d (over doc limit)', `/usersummary-service/stats/steps/daily/${iso(29)}/${iso(1)}`, { showShape: false });
await get('weight all 400d (over doc limit)', `/weight-service/weight/all/${iso(400)}/${iso(0)}`, { showShape: false });
