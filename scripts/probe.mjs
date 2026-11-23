// Phase 0 probe: learn how the Garmin Connect Personal API actually behaves.
//
//   node scripts/probe.mjs
//
// Reads GARMIN_API_KEY from the environment or from .garmin-api-key. Prints only the SHAPE of
// responses (keys, types, counts, dates) and never the key or token. Raw responses go
// to probe-out/ (gitignored) on this machine only. Requests run one at a time with a
// pause between them; it does not try to provoke rate limits.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const BASE = 'https://personal.connectapi.garmin.com';
const OUT = 'probe-out';
const PAUSE_MS = 400;
const MAX_PAGES = 80; // 80 x 99 = 7,920 activities

// ---------- key ----------
function loadKey() {
  if (process.env.GARMIN_API_KEY) return process.env.GARMIN_API_KEY.trim();
  if (existsSync('.garmin-api-key')) {
    for (const line of readFileSync('.garmin-api-key', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*GARMIN_API_KEY\s*=\s*(.*)\s*$/);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  console.error('No GARMIN_API_KEY in the environment or .garmin-api-key');
  process.exit(1);
}
const KEY = loadKey();
const secrets = [KEY];
const redact = (s) => secrets.reduce((acc, x) => (x ? acc.split(x).join('<redacted>') : acc), String(s));
const log = (...a) => console.log(redact(a.join(' ')));

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const save = (name, data) => writeFileSync(`${OUT}/${name}`, data);

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}] ${depth < 3 ? shape(v[0], depth + 1) : '…'}` : '[0]';
  if (typeof v === 'object') {
    if (depth >= 3) return '{…}';
    const pad = '  '.repeat(depth + 1);
    return '{\n' + Object.entries(v).map(([k, x]) => `${pad}${k}: ${shape(x, depth + 1)}`).join('\n') + '\n' + '  '.repeat(depth) + '}';
  }
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

const interestingHeaders = (h) =>
  [...h.entries()].filter(([k]) => /rate|limit|retry|quota|x-ratelimit/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ');

let auth = null;
let requests = 0;

async function call(label, path, { method = 'GET', headers = {}, binary = false } = {}) {
  await sleep(PAUSE_MS);
  requests++;
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers: { Accept: '*/*', ...(auth ? { Authorization: auth } : {}), ...headers } });
  const ms = Date.now() - t0;
  const ct = res.headers.get('content-type') || '';
  const rl = interestingHeaders(res.headers);
  log(`\n[${label}] ${method} ${path} -> ${res.status} ${ms}ms ${ct}${rl ? ' | ' + rl : ''}`);
  if (binary && res.ok) return { res, body: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) log('  error body:', text.slice(0, 400));
  return { res, text, json };
}

function zipEntries(buf) {
  // Walk local file headers (PK\x03\x04) and list names + sizes.
  const out = [];
  for (let i = 0; i + 30 < buf.length; ) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const comp = buf.readUInt32LE(i + 18), size = buf.readUInt32LE(i + 22);
    const nlen = buf.readUInt16LE(i + 26), elen = buf.readUInt16LE(i + 28);
    out.push(`${buf.toString('utf8', i + 30, i + 30 + nlen)} (${size} bytes, ${comp} compressed)`);
    i += 30 + nlen + elen + comp;
  }
  return out;
}

// ---------- 1. token ----------
{
  const { res, json, text } = await call('token', '/personalapitoken-service/personal-api/personal-api-key/token', {
    method: 'POST', headers: { Authorization: `ApiKey ${KEY}` },
  });
  if (!res.ok) { log('Token exchange failed; stopping.'); process.exit(1); }
  let token, type = 'Bearer';
  if (json && typeof json === 'object') {
    log('  token response shape:', shape(json));
    const f = Object.entries(json).find(([k, v]) => typeof v === 'string' && /token/i.test(k));
    if (!f) { log('  no string field with "token" in its name; stopping.'); process.exit(1); }
    token = f[1];
    if (typeof json.token_type === 'string') type = json.token_type;
  } else {
    token = text.trim().replace(/^"|"$/g, '');
    log(`  plain-text token: ${token.length} chars, ${token.split('.').length} dot-separated parts, raw body ${text.length} chars`);
  }
  secrets.push(token);
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      log('  JWT claim names:', Object.keys(claims).join(', '));
      for (const k of ['iat', 'nbf', 'exp']) if (typeof claims[k] === 'number') log(`  ${k}: ${new Date(claims[k] * 1000).toISOString()}`);
      if (claims.exp && claims.iat) log(`  lifetime: ${((claims.exp - claims.iat) / 3600).toFixed(1)} h`);
    } catch { log('  three parts but not a decodable JWT'); }
  }
  auth = `${type.charAt(0).toUpperCase()}${type.slice(1)} ${token}`;
  log(`  using scheme "${auth.split(' ')[0]}"`);
}

// ---------- 2. profile ----------
{
  const { res, json } = await call('profile', '/userprofile-service/userprofile/settings');
  if (res.status === 401 || res.status === 403) { log('  auth scheme rejected; stopping.'); process.exit(1); }
  if (json) { save('profile.json', JSON.stringify(json, null, 2)); log('  top-level keys:', Object.keys(json).join(', ')); }
}

// ---------- 3. activities: page through all ----------
const activities = [];
for (let page = 0; page < MAX_PAGES; page++) {
  const { res, json } = await call(`activities p${page}`, `/activitylist-service/activities/search/activities?start=${page * 99}&limit=99&sortOrder=asc`);
  if (!res.ok || !Array.isArray(json)) { if (json && page === 0) log('  shape:', shape(json)); break; }
  if (page === 0 && json.length) log('  item shape:', shape(json[0]));
  activities.push(...json);
  if (json.length < 99) break;
}
save('activities.json', JSON.stringify(activities, null, 2));
const dateOf = (a) => a.startTimeLocal || a.startTimeGMT || a.beginTimestamp || '?';
log(`\nActivities: ${activities.length}`);
if (activities.length) {
  log(`  oldest: ${dateOf(activities[0])}   newest: ${dateOf(activities.at(-1))}`);
  const types = {};
  for (const a of activities) { const t = a.activityType?.typeKey || '?'; types[t] = (types[t] || 0) + 1; }
  log('  types:', Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
}

// ---------- 4. activity file downloads: newest and oldest ----------
for (const [label, a] of [['newest', activities.at(-1)], ['oldest', activities[0]]]) {
  if (!a?.activityId) continue;
  const r = await call(`download ${label}`, `/download-service/files/activity/${a.activityId}`, { binary: true });
  if (r.body) {
    save(`activity-${label}-${a.activityId}.zip`, r.body);
    log(`  ${r.body.length} bytes; entries: ${zipEntries(r.body).join('; ') || '(not a plain zip)'}`);
  }
}

// ---------- 5. wellness: history depth and range limits ----------
const oldest = activities.length ? new Date(String(dateOf(activities[0])).slice(0, 10)) : daysAgo(3650);
{
  const s = iso(oldest), e = iso(addDays(oldest, 364));
  const { json } = await call('daily summaries v2, first year', `/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`);
  if (json) { save('dailysummaries-first-year.json', JSON.stringify(json, null, 2)); log('  shape:', shape(json)); }
}
{
  const { json } = await call('daily summaries v2, last year', `/usersummary-service/v2/dailysummaries?startDate=${iso(daysAgo(364))}&endDate=${iso(daysAgo(0))}`);
  if (json) save('dailysummaries-last-year.json', JSON.stringify(json, null, 2));
}
{
  const { json } = await call('sleep, 31 days', `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${iso(daysAgo(31))}&endDate=${iso(daysAgo(1))}`);
  if (json) { save('sleep-31d.json', JSON.stringify(json, null, 2)); log('  shape:', shape(json)); }
}
await call('sleep, 40 days (over the limit)', `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${iso(daysAgo(40))}&endDate=${iso(daysAgo(1))}`);
{
  const { json } = await call('hrv, 28 days', `/hrv-service/hrv/daily/${iso(daysAgo(28))}/${iso(daysAgo(1))}`);
  if (json) { save('hrv-28d.json', JSON.stringify(json, null, 2)); log('  shape:', shape(json)); }
}
await call('hrv, 120 days (limit unknown)', `/hrv-service/hrv/daily/${iso(daysAgo(120))}/${iso(daysAgo(1))}`);
{
  const { json } = await call('daily heart rate, yesterday', `/wellness-service/wellness/dailyHeartRate?date=${iso(daysAgo(1))}`);
  if (json) { save('heart-rate-yesterday.json', JSON.stringify(json, null, 2)); log('  shape:', shape(json)); }
}

log(`\nDone. ${requests} requests. Raw responses in ${OUT}/ (gitignored).`);
