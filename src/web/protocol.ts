// Messages between the page and the export worker.

import type { ExportSettings, Progress } from '../core/export';

export type PendingJob = ExportSettings & { startedAt: string; files: number };

export type ToWorker =
  | { type: 'status' }
  | { type: 'verify'; key: string }
  | { type: 'start'; key: string; settings: ExportSettings }
  | { type: 'discard' };

export type FromWorker =
  | { type: 'status'; pending: PendingJob | null }
  | { type: 'verified'; ok: true; expiresAt: number }
  | { type: 'verified'; ok: false; message: string }
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; file: Blob; fileName: string; activities: number; from: string; to: string; failed: Array<{ what: string; reason: string }> }
  | { type: 'error'; message: string };
