// Compare real API responses with the spec's response schemas.
//
//   node packages/personal-api/scripts/check-spec.mjs [--patched] [responses-dir]
//
// --patched checks spec/personal-api.v1.patched.json (after scripts/patch-spec.mjs)
// instead of Garmin's original; it should report 0 differences.
//
// Reads recorded responses (default: probe-out/ at the repo root, gitignored) and
// reports where reality and the spec disagree: wrong type (array vs object, number vs
// string), null where the spec does not allow it, fields the spec does not mention,
// and enum values it does not list. Prints paths and types only, never values.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const patched = args.includes('--patched');
const specFile = patched ? 'personal-api.v1.patched.json' : 'personal-api.v1.json';
const spec = JSON.parse(readFileSync(join(here, '..', 'spec', specFile), 'utf8'));
const dir = args.find((a) => !a.startsWith('--')) ?? join(here, '..', '..', '..', 'probe-out');
console.log(`Checking ${specFile} against ${dir}`);

// Recorded file -> endpoint path (and how the probe wrapped it, if at all).
const RECORDED = {
  'profile.json': '/userprofile-service/userprofile/settings',
  'activities.json': '/activitylist-service/activities/search/activities',
  'dailysummaries-last-year.json': '/usersummary-service/v2/dailysummaries',
  'sleep-31d.json': '/sleep-service/sleep/dailySleepSummariesByDate',
  'hrv-28d.json': '/hrv-service/hrv/daily/{fromDate}/{toDate}',
  'heart-rate-yesterday.json': '/wellness-service/wellness/dailyHeartRate',
  'stress-28d.json': '/usersummary-service/stats/stress/daily/{startDate}/{endDate}',
  'steps-28d.json': '/usersummary-service/stats/steps/daily/{startDate}/{endDate}',
  'bb-31d.json': '/wellness-service/wellness/bodyBattery/reports/daily',
  'vo2-365d.json': '/metrics-service/metrics/maxmet/daily/{startDate}/{endDate}',
  'fitness-age.json': '/fitnessage-service/fitnessage/v2/{calendarDate}',
  'hr-zones.json': '/biometric-service/heartRateZones/v2',
  'hydration-31d.json': '/usersummary-service/stats/hydration/daily/{startDate}/{endDate}',
  'weight-364d.json': '/weight-service/weight/all/{startDate}/{endDate}',
  'wellness-activity-31d.json': '/wellnessactivity-service/activity/summary/range/{fromDate}/{untilDate}',
};

const resolve = (s) => (s?.$ref ? resolve(spec.components.schemas[s.$ref.split('/').pop()]) : s);
const refName = (s) => s?.$ref?.split('/').pop();
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function compare(value, schemaIn, path, issues, seen) {
  const schema = resolve(schemaIn);
  if (!schema) return;
  const where = (refName(schemaIn) ? `${refName(schemaIn)} ` : '') + (path || '(root)');
  const t = typeOf(value);
  if (t === 'null') {
    if (!schema.nullable) issues.add(`null-not-allowed   ${where}`);
    return;
  }
  if (schema.allOf) { schema.allOf.forEach((s) => compare(value, s, path, issues, seen)); return; }
  if (schema.oneOf) {
    const fits = schema.oneOf.some((s) => { const tmp = new Set(); compare(value, s, path, tmp, seen); return tmp.size === 0; });
    if (!fits) issues.add(`type-mismatch      ${where}: fits none of its oneOf forms (got ${t})`);
    return;
  }
  const want = schema.type ?? (schema.properties ? 'object' : undefined);
  const ok = !want || want === t || (want === 'number' && t === 'integer') || (want === 'string' && t === 'string');
  if (!ok) { issues.add(`type-mismatch      ${where}: spec ${want}, got ${t}`); return; }
  if (schema.enum && !schema.enum.includes(value)) issues.add(`enum-unlisted      ${where}`);
  if (t === 'array') {
    const items = schema.items;
    // One example of each item shape is enough; check up to 50 items for nulls/variants.
    value.slice(0, 50).forEach((v) => compare(v, items, path + '[]', issues, seen));
  } else if (t === 'object' && (schema.properties || schema.additionalProperties)) {
    for (const [k, v] of Object.entries(value)) {
      const prop = schema.properties?.[k] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      if (!prop) { issues.add(`field-not-in-spec  ${where}.${k} (${typeOf(v)})`); continue; }
      compare(v, prop, `${path}.${k}`, issues, seen);
    }
  }
}

let total = 0;
for (const [file, apiPath] of Object.entries(RECORDED)) {
  const f = join(dir, file);
  if (!existsSync(f)) { console.log(`\n${file}: not recorded, skipped`); continue; }
  const value = JSON.parse(readFileSync(f, 'utf8'));
  const op = spec.paths[apiPath]?.get;
  const schema = op && Object.values(op.responses?.['200']?.content ?? {})[0]?.schema;
  const issues = new Set();
  if (!schema) issues.add('no response schema in spec');
  else compare(value, schema, '', issues, new Set());
  total += issues.size;
  const empty = Array.isArray(value) && value.length === 0;
  console.log(`\n${apiPath}  (${file}${empty ? ', empty: nothing to compare' : ''})`);
  const byKind = {};
  for (const i of issues) (byKind[i.split(/\s+/)[0]] ??= []).push(i);
  for (const [kind, list] of Object.entries(byKind)) {
    const shown = kind === 'null-not-allowed' ? list.slice(0, 6) : list;
    for (const i of shown) console.log('  ' + i);
    if (shown.length < list.length) console.log(`  … and ${list.length - shown.length} more ${kind}`);
  }
  if (!issues.size) console.log('  matches the spec');
}
console.log(`\n${total} differences in total`);
