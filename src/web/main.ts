import { DATASETS, type DatasetId } from '../core/datasets';
import type { ExportSettings, Progress } from '../core/export';
import type { FromWorker, ToWorker } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

// ---- dataset checkboxes ----
$('datasets').innerHTML = DATASETS.map(
  (d) => `<label class="check"><input type="checkbox" name="ds" value="${d.id}"${d.defaultOn ? ' checked' : ''}> ${d.label}` +
    (d.kind === 'per-day' ? '<span class="tag">one request per day, slow</span>' : '') + '</label>',
).join('');

function settings(): ExportSettings {
  return {
    from: $<HTMLInputElement>('from').value || undefined,
    to: $<HTMLInputElement>('to').value || undefined,
    activities: $<HTMLInputElement>('activities').checked,
    datasets: [...document.querySelectorAll<HTMLInputElement>('input[name=ds]:checked')].map((i) => i.value as DatasetId),
  };
}

function applySettings(s: ExportSettings) {
  $<HTMLInputElement>('from').value = s.from ?? '';
  $<HTMLInputElement>('to').value = s.to ?? '';
  $<HTMLInputElement>('activities').checked = s.activities;
  for (const i of document.querySelectorAll<HTMLInputElement>('input[name=ds]')) i.checked = s.datasets.includes(i.value as DatasetId);
}

// ---- keep the export alive: wake lock + leave warning ----
let wakeLock: { release(): Promise<void> } | null = null;
let running = false;
async function holdAwake(on: boolean) {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (on && wl && !wakeLock) wakeLock = await wl.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or refused: the export still runs */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') void holdAwake(true); });
window.addEventListener('beforeunload', (e) => { if (running) e.preventDefault(); });

// ---- progress ----
const steps = new Map<string, { label: string; done: number; total: number }>();
function render(p: Progress) {
  const headline = $('headline'), wait = $('wait'), bar = $<HTMLProgressElement>('bar');
  if (p.stage !== 'waiting') wait.textContent = '';
  switch (p.stage) {
    case 'token': headline.textContent = 'Checking your key with Garmin…'; break;
    case 'resume': headline.textContent = `Resuming: ${p.kept} files already fetched.`; break;
    case 'listing': headline.textContent = `Finding activities… ${p.found}`; break;
    case 'step': {
      steps.set(p.id, { label: p.label, done: p.done, total: p.total });
      headline.textContent = `${p.label}: ${p.done} of ${p.total}`;
      bar.max = Math.max(p.total, 1);
      bar.value = p.done;
      break;
    }
    case 'zipping': headline.textContent = `Packing your zip: ${p.done} of ${p.total} files`; bar.max = Math.max(p.total, 1); bar.value = p.done; break;
    case 'waiting': wait.textContent = `${p.reason}. Continuing in ${p.seconds} s.`; break;
  }
  $('steps').innerHTML = [...steps.values()].map((s) =>
    `<div class="row"><span>${s.label}</span><span class="${s.done === s.total ? 'done' : 'run'}">${s.done === s.total ? 'Done' : `${s.done} / ${s.total}`}</span></div>`,
  ).join('');
}

// ---- worker messages ----
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.type === 'status') {
    $('pending').hidden = !m.pending;
    if (m.pending) {
      $('pending-text').textContent = `Started ${new Date(m.pending.startedAt).toLocaleString()}, ${m.pending.files} files fetched.`;
      applySettings(m.pending);
    }
  } else if (m.type === 'progress') {
    render(m.progress);
  } else if (m.type === 'done') {
    finish();
    const url = URL.createObjectURL(m.file);
    Object.assign($<HTMLAnchorElement>('download'), { href: url, download: m.fileName });
    $('result').hidden = false;
    $('headline').textContent = `Done: ${m.activities} activities, ${m.from} to ${m.to}, ${(m.file.size / 1e6).toFixed(1)} MB.` +
      (m.failed.length ? ` ${m.failed.length} items could not be fetched (listed in manifest.json).` : '');
    $<HTMLAnchorElement>('download').click();
  } else if (m.type === 'error') {
    finish();
    $('error').textContent = m.message;
    send({ type: 'status' });
  }
};

function finish() {
  running = false;
  void holdAwake(false);
  $<HTMLButtonElement>('go').disabled = false;
  $('wait').textContent = '';
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $<HTMLInputElement>('key').value;
  $<HTMLInputElement>('key').value = ''; // held by the worker's export only
  $('error').textContent = '';
  $('result').hidden = true;
  $('pending').hidden = true;
  $('status').hidden = false;
  steps.clear();
  running = true;
  void holdAwake(true);
  $<HTMLButtonElement>('go').disabled = true;
  send({ type: 'start', key, settings: settings() });
});

$('discard').addEventListener('click', () => send({ type: 'discard' }));
$('remove').addEventListener('click', () => {
  send({ type: 'discard' });
  $('result').hidden = true;
  $('status').hidden = true;
});

send({ type: 'status' });
