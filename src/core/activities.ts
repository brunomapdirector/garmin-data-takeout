// Activities: the paginated list, the original files, and the spreadsheet.

import { unzipSync } from 'fflate';
import type { GarminClient } from './client';
import { toCsv, round, hms, type Column } from './csv';

const PAGE = 99; // Garmin's default and our page size

/** The fields we use from an activity summary. The raw JSON keeps everything. */
export interface Activity {
  activityId: number;
  activityName?: string;
  startTimeLocal?: string;
  startTimeGMT?: string;
  activityType?: { typeKey?: string };
  eventType?: { typeKey?: string };
  distance?: number;
  duration?: number;
  movingDuration?: number;
  elapsedDuration?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  locationName?: string;
  startLatitude?: number;
  startLongitude?: number;
  isManualActivity?: boolean;
  [key: string]: unknown;
}

const day = (a: Activity) => (a.startTimeLocal ?? a.startTimeGMT ?? '').slice(0, 10);

/** Every activity, oldest first, optionally limited to [from, to] (yyyy-MM-dd, inclusive). */
export async function listActivities(
  client: GarminClient,
  opts: { from?: string; to?: string; onPage?: (count: number) => void } = {},
): Promise<Activity[]> {
  const all: Activity[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await client.getJson<Activity[]>('/activitylist-service/activities/search/activities', {
      start,
      limit: PAGE,
      sortOrder: 'asc',
    });
    if (!Array.isArray(page)) break;
    all.push(...page);
    opts.onPage?.(all.length);
    if (page.length < PAGE) break;
  }
  return all.filter((a) => (!opts.from || day(a) >= opts.from) && (!opts.to || day(a) <= opts.to));
}

/**
 * The activity's original file(s). Garmin wraps them in a zip (one `<id>_ACTIVITY.fit`
 * for watch recordings); we unwrap it so the export holds plain files.
 */
export async function downloadActivityFiles(client: GarminClient, id: number): Promise<Array<{ ext: string; data: Uint8Array }>> {
  const zip = await client.getBytes(`/download-service/files/activity/${id}`);
  try {
    return Object.entries(unzipSync(zip))
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, data]) => ({ ext: (name.split('.').pop() ?? 'bin').toLowerCase(), data }));
  } catch {
    return [{ ext: 'zip', data: zip }]; // not a zip after all: keep it as Garmin sent it
  }
}

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'activity';

export function activityFileName(a: Activity, ext: string, index = 0): string {
  const suffix = index ? `-${index + 1}` : '';
  return `${day(a) || 'unknown-date'}_${slug(a.activityName ?? '')}_${a.activityId}${suffix}.${ext}`;
}

const COLUMNS: Column<Activity>[] = [
  ['activity_id', (a) => a.activityId],
  ['date', (a) => day(a)],
  ['start_time_local', (a) => a.startTimeLocal],
  ['name', (a) => a.activityName],
  ['type', (a) => a.activityType?.typeKey],
  ['event_type', (a) => a.eventType?.typeKey],
  ['distance_km', (a) => round((a.distance ?? NaN) / 1000, 3)],
  ['duration', (a) => hms(a.duration)],
  ['moving_time', (a) => hms(a.movingDuration)],
  ['elapsed_time', (a) => hms(a.elapsedDuration)],
  ['duration_s', (a) => round(a.duration, 0)],
  ['elevation_gain_m', (a) => round(a.elevationGain, 1)],
  ['elevation_loss_m', (a) => round(a.elevationLoss, 1)],
  ['avg_speed_kmh', (a) => round((a.averageSpeed ?? NaN) * 3.6, 2)],
  ['max_speed_kmh', (a) => round((a.maxSpeed ?? NaN) * 3.6, 2)],
  ['avg_hr', (a) => round(a.averageHR, 0)],
  ['max_hr', (a) => round(a.maxHR, 0)],
  ['calories', (a) => round(a.calories, 0)],
  ['location', (a) => a.locationName],
  ['start_lat', (a) => round(a.startLatitude, 6)],
  ['start_lon', (a) => round(a.startLongitude, 6)],
  ['manual', (a) => (a.isManualActivity ? 'yes' : 'no')],
  ['garmin_connect_url', (a) => `https://connect.garmin.com/modern/activity/${a.activityId}`],
];

export const activitiesCsv = (activities: Activity[]) => toCsv(activities, COLUMNS);
