// Correct Garmin's spec where real responses disagree with it, before types are
// generated. Input: spec/personal-api.v1.json (as Garmin publishes it).
// Output: spec/personal-api.v1.patched.json (what `npm run gen` reads).
//
// Every patch names its evidence: the recorded response that showed the difference
// (scripts/check-spec.mjs lists them). Where only part of a pattern could be seen,
// the patch allows both forms instead of guessing.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const spec = JSON.parse(readFileSync(join(dir, 'personal-api.v1.json'), 'utf8'));
const S = spec.components.schemas;
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const applied = [];
const patch = (what, evidence, fn) => { fn(); applied.push(`${what}  [${evidence}]`); };

// 1. Nulls. The spec marks nothing nullable; Garmin sends null for any missing value
//    (empty sleep nights, HRV before the watch had it, unused settings). Every property
//    of every schema may be null.
patch('every property nullable', 'sleep, hrv, profile, stress, hr zones, vo2max', () => {
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    for (const p of Object.values(s.properties ?? {})) {
      if (p.$ref) { const r = p.$ref; for (const k of Object.keys(p)) delete p[k]; p.allOf = [{ $ref: r }]; }
      p.nullable = true;
      walk(p);
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      s.additionalProperties.nullable = true; // maps, e.g. stress `values`
      walk(s.additionalProperties);
    }
    walk(s.items);
    for (const k of ['allOf', 'oneOf', 'anyOf']) (s[k] ?? []).forEach(walk);
  };
  Object.values(S).forEach(walk);
});

// 2. Sleep window timestamps are epoch milliseconds (numbers), not date-time strings.
patch('DailySleepDTO sleepStart/End Timestamp GMT/Local: integer (epoch ms)', 'sleep-31d', () => {
  for (const k of ['sleepStartTimestampGMT', 'sleepEndTimestampGMT', 'sleepStartTimestampLocal', 'sleepEndTimestampLocal']) {
    S.DailySleepDTO.properties[k] = { type: 'integer', format: 'int64', nullable: true, description: (S.DailySleepDTO.properties[k].description ?? '') + ' Epoch milliseconds.' };
  }
});
patch('DailySleepDTO autoSleep* timestamps: integer or string (only null seen)', 'sleep-31d', () => {
  for (const k of ['autoSleepStartTimestampGMT', 'autoSleepEndTimestampGMT']) {
    S.DailySleepDTO.properties[k] = { oneOf: [{ type: 'integer', format: 'int64' }, { type: 'string' }], nullable: true, description: S.DailySleepDTO.properties[k].description };
  }
});

// 3. ConnectDate / ConnectTimestamp are documented as {date, localDate} objects but the
//    heart-rate endpoint sends plain strings. Seen there only, so elsewhere allow both.
patch('DailyHeartRateDTO dates and timestamps: string', 'heart-rate-yesterday', () => {
  const p = S.DailyHeartRateDTO.properties;
  p.calendarDate = { type: 'string', format: 'date', nullable: true };
  for (const k of ['startTimestampGMT', 'endTimestampGMT', 'startTimestampLocal', 'endTimestampLocal']) p[k] = { type: 'string', nullable: true, description: 'yyyy-MM-ddTHH:mm:ss.S' };
});
patch('ConnectDate / ConnectTimestamp elsewhere: string or the documented object', 'heart-rate-yesterday', () => {
  S.ConnectDateObject = S.ConnectDate;
  S.ConnectTimestampObject = S.ConnectTimestamp;
  S.ConnectDate = { oneOf: [{ type: 'string', format: 'date' }, ref('ConnectDateObject')] };
  S.ConnectTimestamp = { oneOf: [{ type: 'string' }, ref('ConnectTimestampObject')] };
});

// 4. Time series are arrays of [timestamp, value] number pairs, not arrays of objects.
patch('heartRateValues / bodyBatteryValuesArray: [epochMs, value | null][]', 'heart-rate-yesterday, bb-31d', () => {
  const pair = { type: 'array', items: { type: 'number', nullable: true }, description: '[epoch ms, value]; value is null when there was no reading.' };
  S.DailyHeartRateDTO.properties.heartRateValues = { type: 'array', items: pair, nullable: true };
  S.BodyBatteryDailyReportDTO.properties.bodyBatteryValuesArray = { ...S.BodyBatteryDailyReportDTO.properties.bodyBatteryValuesArray, items: pair, nullable: true };
});

// 5. Fitness age returns one object, not an array.
patch('fitnessage v2 response: FitnessAgeDTO (not array)', 'fitness-age', () => {
  const content = spec.paths['/fitnessage-service/fitnessage/v2/{calendarDate}'].get.responses['200'].content;
  for (const c of Object.values(content)) c.schema = ref('FitnessAgeDTO');
});

// 6. Fields Garmin sends that the spec does not list.
patch('HydrationV2DTO.consumedInMl, DailySleepDTO.retro, VO2MaxDTO.sport/subSport', 'dailysummaries, sleep-31d, vo2-365d', () => {
  S.HydrationV2DTO.properties.consumedInMl = { type: 'integer', nullable: true };
  S.DailySleepDTO.properties.retro = { type: 'boolean', nullable: true };
  S.VO2MaxDTO.properties.sport = { type: 'string', nullable: true };
  S.VO2MaxDTO.properties.subSport = { type: 'string', nullable: true };
});

spec.info['x-patched'] = applied;
writeFileSync(join(dir, 'personal-api.v1.patched.json'), JSON.stringify(spec, null, 2) + '\n');
console.log(`Applied ${applied.length} patches:\n  ` + applied.join('\n  '));

// The input for type generation keeps only structure: Garmin's prose (descriptions,
// examples, summaries) stays out of the generated types, which are committed and
// published, while the spec itself is not redistributed.
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    // (Property NAMES like "description" are safe: `properties` maps are walked below.)
    if (['description', 'example', 'examples', 'summary', 'title', 'externalDocs'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(x).map(([p, s]) => [p, strip(s)])) : strip(x);
  }
  return out;
};
const structural = strip(spec);
structural.info = { title: 'Garmin Connect Personal API (structure only)', version: spec.info.version };
writeFileSync(join(dir, 'personal-api.v1.structure.json'), JSON.stringify(structural, null, 2) + '\n');
console.log('Wrote the structure-only spec for type generation (no Garmin prose).');
