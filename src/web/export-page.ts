// The export page: key -> choose -> progress -> done. The export itself runs in
// export.worker.ts; this file only shows screens and passes messages.

import './style.css';
import { fillCommon } from './common';
import { DATASETS, type DatasetId } from '../core/datasets';
import type { ExportSettings, Progress } from '../core/export';
import type { FromWorker, PendingJob, ToWorker } from './protocol';

fillCommon();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = ['s-key', 's-choose', 's-progress', 's-done'] as const;
function show(id: (typeof screens)[number]) {
  for (const s of screens) $(s).hidden = s !== id;
  window.scrollTo({ top: 0 });
}

// The key lives here only between screen 1 and pressing Start, then only in the worker.
let key: string | null = null;
let running = false;
let pending: PendingJob | null = null;

// ---- worker ----
let worker: Worker;
const send = (m: ToWorker) => worker.postMessage(m);
function makeWorker() {
  worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
}
makeWorker();

// ---- dataset checkboxes, grouped ----
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const row = (id: string, label: string, on: boolean, tag = '') =>
  `<div class="row"><label><input type="checkbox" name="ds" value="${id}"${on ? ' checked' : ''}> ${esc(label)}</label><span class="tag">${tag}</span></div>`;
$('ds-main').innerHTML = DATASETS.filter((d) => d.kind === 'range' && d.defaultOn).map((d) => row(d.id, d.label, true)).join('');
$('ds-detail').innerHTML = DATASETS.filter((d) => d.kind === 'range' && !d.defaultOn).map((d) => row(d.id, d.label, false)).join('');
$('ds-day').innerHTML = DATASETS.filter((d) => d.kind === 'per-day')
  .map((d) => row(d.id, d.label, false, d.id === 'womens-health-per-day' ? 'private, off unless you choose it' : ''))
  .join('');

function readSettings(): ExportSettings {
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

// ---- keep the export alive while it runs ----
type Lock = { release(): Promise<void> };
let wakeLock: Lock | null = null;
async function holdAwake(on: boolean) {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Lock> } }).wakeLock;
    if (on && wl && !wakeLock) wakeLock = await wl.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* unsupported or refused: the export still runs */ }
}
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') { wakeLock = null; void holdAwake(true); }
});
window.addEventListener('beforeunload', (e) => { if (running) e.preventDefault(); });

// ---- screen 1: key ----
$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $<HTMLInputElement>('key').value.trim();
  if (!value) return;
  $('key-error').textContent = '';
  $<HTMLButtonElement>('key-go').disabled = true;
  $<HTMLButtonElement>('key-go').textContent = 'Checking with Garmin…';
  key = value;
  send({ type: 'verify', key: value });
});
$('discard').addEventListener('click', () => send({ type: 'discard' }));

// ---- screen 2: choose ----
$('back').addEventListener('click', () => { key = null; show('s-key'); });
$('start').addEventListener('click', () => {
  if (!key) { show('s-key'); return; }
  const settings = readSettings();
  send({ type: 'start', key, settings });
  key = null;
  running = true;
  void holdAwake(true);
  steps.clear();
  renderSteps();
  $('headline').textContent = 'Starting…';
  $('wait').textContent = '';
  $('run-error').textContent = '';
  $('retry').hidden = true;
  $('stop').hidden = false;
  show('s-progress');
});

// ---- screen 3: progress ----
const steps = new Map<string, { label: string; done: number; total: number }>();
function renderSteps() {
  $('steps').innerHTML = [...steps.values()]
    .map((s) => {
      const finished = s.done >= s.total;
      return `<div class="row"><span>${esc(s.label)}</span><span class="${finished ? 's-ok' : 's-run'}">${finished ? 'Done' : `${s.done} / ${s.total}`}</span></div>`;
    })
    .join('');
}
function setBar(done: number, total: number) {
  $('bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}
function render(p: Progress) {
  if (p.stage !== 'waiting') $('wait').textContent = '';
  switch (p.stage) {
    case 'token': $('headline').textContent = 'Checking your key with Garmin…'; break;
    case 'resume': $('headline').textContent = `Continuing an earlier export: ${p.kept} files already fetched.`; break;
    case 'listing': $('headline').textContent = `Finding your activities… ${p.found}`; break;
    case 'step':
      steps.set(p.id, { label: p.label, done: p.done, total: p.total });
      $('headline').textContent = `${p.label}: ${p.done} of ${p.total}`;
      setBar(p.done, p.total);
      renderSteps();
      break;
    case 'zipping':
      $('headline').textContent = `Packing your zip: ${p.done} of ${p.total} files`;
      setBar(p.done, p.total);
      break;
    case 'waiting': $('wait').textContent = `${p.reason}. Continuing in ${p.seconds} seconds.`; break;
  }
}
function stopped() {
  running = false;
  void holdAwake(false);
}
$('stop').addEventListener('click', () => {
  worker.terminate(); // files fetched so far stay in the browser; the same choices resume
  makeWorker();
  stopped();
  send({ type: 'status' });
  show('s-key');
});
$('retry').addEventListener('click', () => { send({ type: 'status' }); show('s-key'); });

// ---- screen 4: done ----
$('remove').addEventListener('click', () => {
  send({ type: 'discard' });
  $<HTMLButtonElement>('remove').disabled = true;
  $<HTMLButtonElement>('remove').textContent = 'Removed';
  $('download').hidden = true;
});

// ---- messages from the worker ----
function onMessage(m: FromWorker) {
  switch (m.type) {
    case 'status':
      pending = m.pending;
      $('pending').hidden = !pending;
      if (pending) {
        $('pending-text').textContent = `Started ${new Date(pending.startedAt).toLocaleString()}, ${pending.files} files fetched.`;
        applySettings(pending);
      }
      break;
    case 'verified':
      $<HTMLButtonElement>('key-go').disabled = false;
      $<HTMLButtonElement>('key-go').textContent = 'Continue';
      if (m.ok) {
        $<HTMLInputElement>('key').value = '';
        show('s-choose');
      } else {
        key = null;
        $('key-error').textContent = m.message;
      }
      break;
    case 'progress':
      render(m.progress);
      break;
    case 'done': {
      stopped();
      const url = URL.createObjectURL(m.file);
      Object.assign($<HTMLAnchorElement>('download'), { href: url, download: m.fileName });
      $('done-big').textContent = m.activities ? `${m.activities.toLocaleString()} activities` : 'Your data';
      $('done-sub').textContent = `${m.from} to ${m.to} · ${(m.file.size / 1e6).toFixed(1)} MB`;
      $('failed').textContent = m.failed.length
        ? `${m.failed.length} item${m.failed.length > 1 ? 's' : ''} could not be fetched; manifest.json in the zip lists ${m.failed.length > 1 ? 'them' : 'it'}.`
        : '';
      show('s-done');
      break;
    }
    case 'error':
      stopped();
      $('run-error').textContent = m.message;
      $('stop').hidden = true;
      $('retry').hidden = false;
      break;
  }
}

send({ type: 'status' });
