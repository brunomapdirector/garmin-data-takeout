// The export runs here, not on the page: a worker's timers are not throttled when the
// tab is in the background, and OPFS synchronous file access is only available here.
// The key arrives in a 'verify' or 'start' message and lives only inside those calls.

import { runExport, pendingJob } from '../core/export';
import { TokenSource } from '../core/token';
import { OpfsStore } from './opfs-store';
import type { ToWorker, FromWorker } from './protocol';

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
let running = false;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'start' && running) return; // one export at a time
  try {
    if (msg.type === 'verify') {
      // One token exchange, so a mistyped key is caught on the first screen.
      const tokens = new TokenSource('', msg.key);
      try {
        await tokens.get();
        post({ type: 'verified', ok: true, expiresAt: tokens.expiresAt });
      } catch (err) {
        post({ type: 'verified', ok: false, message: err instanceof Error ? err.message : String(err) });
      } finally {
        tokens.forget();
      }
      return;
    }
    const store = await OpfsStore.open();
    if (msg.type === 'status') {
      post({ type: 'status', pending: running ? null : await pendingJob(store) });
    } else if (msg.type === 'discard') {
      if (!running) await store.clear();
      post({ type: 'status', pending: null });
    } else if (msg.type === 'start') {
      running = true;
      const result = await runExport({
        ...msg.settings,
        relay: '',
        key: msg.key,
        store,
        onProgress: (progress) => post({ type: 'progress', progress }),
      });
      post({ type: 'done', file: result.blob, fileName: result.fileName, activities: result.activities, from: result.from, to: result.to, failed: result.failed });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (msg.type === 'start') running = false;
  }
};
