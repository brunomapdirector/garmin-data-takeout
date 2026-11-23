// The wellness datasets: which endpoint, how many days one request may cover, and
// how to turn the responses into a spreadsheet. Range limits are Garmin's documented
// ones, confirmed by the probes (one day over the limit returns 400 with body {}).

export type DatasetId =
  | 'daily-summary' | 'sleep' | 'stress' | 'steps' | 'body-battery' | 'hrv'
  | 'weight' | 'hydration' | 'vo2max' | 'wellness-activities'
  | 'heart-rate-per-day' | 'spo2-per-day' | 'sleep-detail-per-day' | 'nutrition-per-day'
  | 'womens-health-per-day';

export interface RangeDataset {
  kind: 'range';
  id: DatasetId;
  label: string;
  defaultOn: boolean;
  /** Max days per request (inclusive range). */
  chunkDays: number;
  request(from: string, to: string): { path: string; query?: Record<string, string> };
}

export interface PerDayDataset {
  kind: 'per-day';
  id: DatasetId;
  label: string;
  defaultOn: boolean;
  /** One or more requests per calendar day; raw JSON only, no spreadsheet. */
  requests(date: string): Array<{ name: string; path: string; query?: Record<string, string> }>;
}

export type Dataset = RangeDataset | PerDayDataset;

const range = (path: (f: string, t: string) => string) => (f: string, t: string) => ({ path: path(f, t) });
const rangeQuery = (path: string) => (f: string, t: string) => ({ path, query: { startDate: f, endDate: t } });

export const DATASETS: Dataset[] = [
  { kind: 'range', id: 'daily-summary', label: 'Daily summary (steps, calories, stress, Body Battery, respiration)', defaultOn: true, chunkDays: 365,
    request: rangeQuery('/usersummary-service/v2/dailysummaries') },
  { kind: 'range', id: 'sleep', label: 'Sleep', defaultOn: true, chunkDays: 31,
    request: rangeQuery('/sleep-service/sleep/dailySleepSummariesByDate') },
  { kind: 'range', id: 'hrv', label: 'HRV', defaultOn: true, chunkDays: 365,
    request: range((f, t) => `/hrv-service/hrv/daily/${f}/${t}`) },
  { kind: 'range', id: 'weight', label: 'Weight', defaultOn: true, chunkDays: 364,
    request: range((f, t) => `/weight-service/weight/all/${f}/${t}`) },
  // Off by default: their daily numbers are already in the daily summary, and at
  // 28-31 days per request they cost ~400 requests per 8 years (minutes of rate limit).
  { kind: 'range', id: 'body-battery', label: 'Body Battery detail (values through the day, events)', defaultOn: false, chunkDays: 31,
    request: rangeQuery('/wellness-service/wellness/bodyBattery/reports/daily') },
  { kind: 'range', id: 'stress', label: 'Stress detail (time per stress level)', defaultOn: false, chunkDays: 28,
    request: range((f, t) => `/usersummary-service/stats/stress/daily/${f}/${t}`) },
  { kind: 'range', id: 'steps', label: 'Steps detail (with step goal)', defaultOn: false, chunkDays: 28,
    request: range((f, t) => `/usersummary-service/stats/steps/daily/${f}/${t}`) },
  { kind: 'range', id: 'hydration', label: 'Hydration detail', defaultOn: false, chunkDays: 31,
    request: range((f, t) => `/usersummary-service/stats/hydration/daily/${f}/${t}`) },
  { kind: 'range', id: 'vo2max', label: 'VO2 max', defaultOn: true, chunkDays: 365,
    request: range((f, t) => `/metrics-service/metrics/maxmet/daily/${f}/${t}`) },
  { kind: 'range', id: 'wellness-activities', label: 'Wellness activities', defaultOn: true, chunkDays: 365,
    request: range((f, t) => `/wellnessactivity-service/activity/summary/range/${f}/${t}`) },

  { kind: 'per-day', id: 'heart-rate-per-day', label: 'Heart rate through the day', defaultOn: false,
    requests: (d) => [{ name: d, path: '/wellness-service/wellness/dailyHeartRate', query: { date: d } }] },
  { kind: 'per-day', id: 'spo2-per-day', label: 'SpO2 through the day', defaultOn: false,
    requests: (d) => [{ name: d, path: `/wellness-service/wellness/daily/spo2acclimation/${d}` }] },
  { kind: 'per-day', id: 'sleep-detail-per-day', label: 'Sleep detail (stages, movement)', defaultOn: false,
    requests: (d) => [{ name: d, path: '/sleep-service/sleep/dailySleep', query: { date: d } }] },
  { kind: 'per-day', id: 'nutrition-per-day', label: 'Nutrition logs', defaultOn: false,
    requests: (d) => [{ name: d, path: `/nutrition-service/food/logs/${d}` }] },
  { kind: 'per-day', id: 'womens-health-per-day', label: "Women's health", defaultOn: false,
    requests: (d) => [
      { name: `${d}-summary`, path: `/periodichealth-service/menstrualcycle/summary/${d}` },
      { name: `${d}-day`, path: `/periodichealth-service/menstrualcycle/dayview/${d}` },
    ] },
];

/** Requested once per export, whatever the date range. */
export const SINGLETONS = [
  { name: 'profile-settings', path: '/userprofile-service/userprofile/settings' },
  { name: 'heart-rate-zones', path: '/biometric-service/heartRateZones/v2' },
  { name: 'activity-types', path: '/activity-service/activity/activityTypes/simple' },
  { name: 'fitness-age', path: 'FITNESS_AGE' }, // dated: filled in with the export's end date
];

// ---------- dates ----------

const toDate = (s: string) => new Date(s + 'T00:00:00Z');
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** Inclusive [from, to] split into windows of at most `days` days. */
export function chunks(from: string, to: string, days: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let s = from; s <= to; s = addDays(s, days)) {
    const e = addDays(s, days - 1);
    out.push([s, e < to ? e : to]);
  }
  return out;
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- rows for spreadsheets ----------

/** The list of records in a response: the response itself, or its first array field. */
export function rowsOf(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object');
  if (json && typeof json === 'object') {
    const arr = Object.values(json).find(Array.isArray);
    if (arr) return arr.filter((x) => x && typeof x === 'object');
  }
  return [];
}

/**
 * Nested objects become dotted columns (`movement.steps.value`). Arrays (time series,
 * event lists) stay out of the spreadsheet; they are in raw/.
 */
export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, string | number> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined || Array.isArray(v)) continue;
    if (/^(uuid|userProfilePk|id|deviceId)$/i.test(k)) continue; // internal ids, in raw/ only
    if (typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
    else out[key] = typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v as string | number);
  }
  return out;
}

/** A row counts only if it has some value besides its date (Garmin sends empty nights). */
export function hasData(flat: Record<string, string | number>): boolean {
  return Object.entries(flat).some(([k, v]) => !/date|^id$|userprofile|uuid/i.test(k) && v !== '' && v !== 0);
}
