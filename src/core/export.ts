// The whole export: activities, wellness datasets and profile, written file by file
// into an ExportStore, then streamed into one zip. Everything already in the store
// from an interrupted run with the same settings is kept, so a rerun resumes.

import { GarminClient, ApiError, type WaitHandler } from './client';
import { TokenSource } from './token';
import { listActivities, downloadActivityFiles, activitiesCsv, activityFileName, type Activity } from './activities';
import { DATASETS, SINGLETONS, chunks, eachDay, rowsOf, flatten, hasData, type DatasetId } from './datasets';
import { flatRowsToCsv } from './csv';
import { zipStore } from './zip';
import { writeJson, writeText, readJson, type ExportStore } from './store';

export const VERSION = '0.2.0';
const JOB = 'job.json';

export type Progress =
  | { stage: 'token' }
  | { stage: 'resume'; kept: number }
  | { stage: 'listing'; found: number }
  | { stage: 'step'; id: string; label: string; done: number; total: number }
  | { stage: 'zipping'; done: number; total: number }
  | { stage: 'waiting'; seconds: number; reason: string };

export interface ExportSettings {
  from?: string; // yyyy-MM-dd; default: the first activity's date
  to?: string; // default: today
  activities: boolean;
  datasets: DatasetId[];
}

export interface ExportOptions extends ExportSettings {
  relay: string; // '' for same origin
  key: string;
  store: ExportStore;
  onProgress: (p: Progress) => void;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  activities: number;
  from: string;
  to: string;
  failed: Array<{ what: string; reason: string }>;
}

const today = () => new Date().toISOString().slice(0, 10);
const reason = (e: unknown) => (e instanceof ApiError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e));

/** The settings an unfinished export in this store was started with, if any. */
type Job = ExportSettings & { startedAt: string; resolved?: { from: string; to: string } };

export async function pendingJob(store: ExportStore): Promise<(Job & { files: number }) | null> {
  if (!(await store.has(JOB))) return null;
  const job = await readJson<Job>(store, JOB);
  return { ...job, files: (await store.list()).length - 1 };
}

const sameSettings = (a: ExportSettings, b: ExportSettings) =>
  (a.from ?? '') === (b.from ?? '') &&
  (a.to ?? '') === (b.to ?? '') &&
  a.activities === b.activities &&
  [...a.datasets].sort().join() === [...b.datasets].sort().join();

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const { store, onProgress } = opts;
  const tokens = new TokenSource(opts.relay, opts.key);
  const onWait: WaitHandler = (seconds, why) => onProgress({ stage: 'waiting', seconds, reason: why });
  const client = new GarminClient(opts.relay, tokens, onWait);
  const failed: ExportResult['failed'] = [];
  const settings: ExportSettings = { from: opts.from, to: opts.to, activities: opts.activities, datasets: opts.datasets };

  try {
    onProgress({ stage: 'token' });
    await tokens.get();

    // Resume only an export started with exactly these settings; otherwise start clean.
    const pending = await pendingJob(store);
    const resuming = !!pending && sameSettings(pending, settings);
    if (resuming) {
      onProgress({ stage: 'resume', kept: pending.files });
    } else {
      await store.clear();
      await writeJson(store, JOB, { ...settings, startedAt: new Date().toISOString() });
    }
    const have = new Set(await store.list());

    // The activity list also gives the default start date: the first activity.
    const allActivities = await listActivities(client, { onPage: (found) => onProgress({ stage: 'listing', found }) });
    // A resumed export keeps the dates it started with, so a run that crosses midnight
    // does not get a second, overlapping last window.
    const firstDay = (allActivities[0]?.startTimeLocal ?? '').slice(0, 10);
    const to = (resuming && pending?.resolved?.to) || opts.to || today();
    const from = (resuming && pending?.resolved?.from) || opts.from || firstDay || `${Number(to.slice(0, 4)) - 10}${to.slice(4)}`;
    if (!resuming) await writeJson(store, JOB, { ...settings, startedAt: new Date().toISOString(), resolved: { from, to } });
    const day = (a: Activity) => (a.startTimeLocal ?? a.startTimeGMT ?? '').slice(0, 10);
    const activities = allActivities.filter((a) => day(a) >= from && day(a) <= to);

    // ---- activities ----
    if (opts.activities) {
      await writeText(store, 'activities/activities.csv', activitiesCsv(activities));
      await writeJson(store, 'activities/activities.json', activities);
      const doneIds = new Set(
        [...have].map((p) => p.match(/^activities\/files\/.*_(\d+)(?:-\d+)?\.[a-z0-9]+$/i)?.[1]).filter(Boolean),
      );
      const todo = activities.filter((a) => !doneIds.has(String(a.activityId)));
      let done = activities.length - todo.length;
      const label = 'Activities';
      onProgress({ stage: 'step', id: 'activities', label, done, total: activities.length });
      await pool(todo, 2, async (a) => {
        try {
          const parts = await downloadActivityFiles(client, a.activityId);
          for (const [i, p] of parts.entries()) await store.write('activities/files/' + activityFileName(a, p.ext, i), p.data);
        } catch (e) {
          failed.push({ what: `activity ${a.activityId}`, reason: reason(e) });
        }
        onProgress({ stage: 'step', id: 'activities', label, done: ++done, total: activities.length });
      });
    }

    // ---- profile and other one-off data ----
    for (const s of SINGLETONS) {
      const path = `raw/profile/${s.name}.json`;
      try {
        const apiPath = s.path === 'FITNESS_AGE' ? `/fitnessage-service/fitnessage/v2/${to}` : s.path;
        await writeJson(store, path, await client.getJson(apiPath));
      } catch (e) {
        failed.push({ what: s.name, reason: reason(e) });
      }
    }

    // ---- wellness ----
    for (const ds of DATASETS.filter((d) => opts.datasets.includes(d.id))) {
      const jobs =
        ds.kind === 'range'
          ? chunks(from, to, ds.chunkDays).map(([f, t]) => ({ file: `raw/${ds.id}/${f}_${t}.json`, ...ds.request(f, t) }))
          : eachDay(from, to).flatMap((d) => ds.requests(d).map((r) => ({ file: `raw/${ds.id}/${r.name}.json`, ...r })));
      const todo = jobs.filter((j) => !have.has(j.file));
      let done = jobs.length - todo.length;
      onProgress({ stage: 'step', id: ds.id, label: ds.label, done, total: jobs.length });
      await pool(todo, 2, async (j) => {
        try {
          await writeJson(store, j.file, await client.getJson(j.path, j.query));
        } catch (e) {
          failed.push({ what: `${ds.id} ${j.file.split('/').pop()}`, reason: reason(e) });
        }
        onProgress({ stage: 'step', id: ds.id, label: ds.label, done: ++done, total: jobs.length });
      });

      // Spreadsheet from what is stored (so a resumed export includes earlier windows).
      if (ds.kind === 'range') {
        const rows: Array<Record<string, string | number>> = [];
        for (const j of jobs) {
          if (!(await store.has(j.file))) continue;
          for (const r of rowsOf(await readJson(store, j.file))) {
            const flat = flatten(r);
            if (hasData(flat)) rows.push(flat);
          }
        }
        if (rows.length) await writeText(store, `wellness/${ds.id}.csv`, flatRowsToCsv(rows, ['calendarDate', 'date']));
      }
    }

    // ---- manifest and readme ----
    await writeJson(store, 'manifest.json', {
      tool: 'garmin-data-takeout', version: VERSION, exportedAt: new Date().toISOString(),
      range: { from, to }, activities: opts.activities ? activities.length : 0, datasets: opts.datasets, failed,
    });
    await writeText(store, 'README.txt', readme(from, to, opts));

    // ---- zip ----
    const paths = (await store.list()).filter((p) => p !== JOB).sort();
    const root = `garmin-data-takeout-${to}/`;
    const sink = await store.openOutput('garmin-data-takeout.zip');
    onProgress({ stage: 'zipping', done: 0, total: paths.length });
    const blob = await zipStore(store, paths, root, sink, (done, total) => onProgress({ stage: 'zipping', done, total }));

    return { blob, fileName: `garmin-data-takeout-${to}.zip`, activities: activities.length, from, to, failed };
  } finally {
    tokens.forget();
  }
}

function readme(from: string, to: string, opts: ExportSettings): string {
  const lines = [
    'Garmin Data Takeout',
    '===================',
    '',
    `Exported ${new Date().toISOString().slice(0, 10)}, covering ${from} to ${to}.`,
    "Everything here came from Garmin's Personal API, unchanged, plus spreadsheets made from it.",
    '',
    'activities/activities.csv   One row per activity. Opens in Excel, Numbers, Google Sheets.',
    'activities/files/           The original file of every activity (usually .fit).',
    '                            Strava, TrainingPeaks and most training apps import these.',
    'wellness/*.csv              One spreadsheet per dataset, one row per day.',
    'raw/                        Every API response as Garmin sent it (JSON).',
    'manifest.json               What was exported, and anything that could not be fetched.',
    '',
    `Datasets: ${['activities', ...opts.datasets].filter((d) => d !== 'activities' || opts.activities).join(', ')}`,
    '',
    'Made with garmin-data-takeout. Not affiliated with Garmin.',
  ];
  return lines.join('\r\n') + '\r\n';
}
