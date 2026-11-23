// Phase 1 export: activities only (list, spreadsheet, original files) into one zip.
// Later phases add the wellness datasets through the same shape.

import { zipSync, strToU8 } from 'fflate';
import { GarminClient, ApiError, type WaitHandler } from './client';
import { TokenSource } from './token';
import { listActivities, downloadActivityFiles, activitiesCsv, activityFileName } from './activities';

export type Progress =
  | { stage: 'token' }
  | { stage: 'listing'; found: number }
  | { stage: 'files'; done: number; total: number }
  | { stage: 'zipping' }
  | { stage: 'waiting'; seconds: number; reason: string };

export interface ExportOptions {
  relay: string; // '' for same origin
  key: string;
  from?: string;
  to?: string;
  onProgress: (p: Progress) => void;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  activities: number;
  failed: Array<{ activityId: number; reason: string }>;
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const tokens = new TokenSource(opts.relay, opts.key);
  const onWait: WaitHandler = (seconds, reason) => opts.onProgress({ stage: 'waiting', seconds, reason });
  const client = new GarminClient(opts.relay, tokens, onWait);
  const today = new Date().toISOString().slice(0, 10);
  const root = `garmin-data-takeout-${today}/`;
  const files: Record<string, Uint8Array> = {};
  const failed: ExportResult['failed'] = [];

  try {
    opts.onProgress({ stage: 'token' });
    await tokens.get();

    const activities = await listActivities(client, {
      from: opts.from,
      to: opts.to,
      onPage: (found) => opts.onProgress({ stage: 'listing', found }),
    });
    files[root + 'activities/activities.csv'] = strToU8(activitiesCsv(activities));
    files[root + 'activities/activities.json'] = strToU8(JSON.stringify(activities, null, 2));

    // Two at a time (the client's limit); a failed file is recorded, not fatal.
    let done = 0, next = 0;
    opts.onProgress({ stage: 'files', done, total: activities.length });
    const worker = async () => {
      while (next < activities.length) {
        const a = activities[next++];
        try {
          const parts = await downloadActivityFiles(client, a.activityId);
          parts.forEach((p, i) => (files[root + 'activities/files/' + activityFileName(a, p.ext, i)] = p.data));
        } catch (e) {
          failed.push({ activityId: a.activityId, reason: e instanceof ApiError ? `HTTP ${e.status}` : String(e) });
        }
        opts.onProgress({ stage: 'files', done: ++done, total: activities.length });
      }
    };
    await Promise.all([worker(), worker()]);

    files[root + 'manifest.json'] = strToU8(
      JSON.stringify(
        {
          tool: 'garmin-data-takeout',
          version: '0.1.0',
          exportedAt: new Date().toISOString(),
          range: { from: opts.from ?? null, to: opts.to ?? null },
          activities: activities.length,
          failedFiles: failed,
        },
        null,
        2,
      ),
    );

    opts.onProgress({ stage: 'zipping' });
    // FIT files barely compress further; store them, deflate the text.
    const zip = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, data]) => [name, [data, { level: /\.(fit|zip)$/.test(name) ? 0 : 6 }]]),
      ),
    );
    return {
      blob: new Blob([zip], { type: 'application/zip' }),
      fileName: `garmin-data-takeout-${today}.zip`,
      activities: activities.length,
      failed,
    };
  } finally {
    tokens.forget();
  }
}
