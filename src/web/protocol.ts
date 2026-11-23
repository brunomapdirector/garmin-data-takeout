// Messages between the page and the export worker.

import type { ExportSettings, Progress } from '../core/export';

export type ToWorker =
  | { type: 'status' }
  | { type: 'start'; key: string; settings: ExportSettings }
  | { type: 'discard' };

export type FromWorker =
  | { type: 'status'; pending: (ExportSettings & { startedAt: string; files: number }) | null }
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; file: Blob; fileName: string; activities: number; from: string; to: string; failed: Array<{ what: string; reason: string }> }
  | { type: 'error'; message: string };
