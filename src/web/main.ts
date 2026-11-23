import { runExport, type Progress } from '../core/export';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const keyInput = $<HTMLInputElement>('key');
const go = $<HTMLButtonElement>('go');
const status = $('status');
const bar = $<HTMLProgressElement>('bar');
const error = $('error');

function show(p: Progress) {
  bar.hidden = p.stage !== 'files';
  switch (p.stage) {
    case 'token': status.textContent = 'Checking your key with Garmin…'; break;
    case 'listing': status.textContent = `Finding activities… ${p.found}`; break;
    case 'files':
      status.textContent = `Downloading files: ${p.done} of ${p.total}`;
      bar.max = Math.max(p.total, 1);
      bar.value = p.done;
      break;
    case 'zipping': status.textContent = 'Packing your zip…'; break;
    case 'waiting': status.textContent = `${p.reason}. Continuing in ${p.seconds} s.`; break;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  go.disabled = true;
  const key = keyInput.value;
  keyInput.value = ''; // the key is held by the export only, not by the page
  try {
    const result = await runExport({
      relay: '',
      key,
      from: $<HTMLInputElement>('from').value || undefined,
      to: $<HTMLInputElement>('to').value || undefined,
      onProgress: show,
    });
    const url = URL.createObjectURL(result.blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: result.fileName });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    const mb = (result.blob.size / 1e6).toFixed(1);
    status.textContent = `Done: ${result.activities} activities, ${mb} MB.` +
      (result.failed.length ? ` ${result.failed.length} files could not be downloaded (listed in manifest.json).` : '');
    bar.hidden = true;
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    status.textContent = '';
    bar.hidden = true;
  } finally {
    go.disabled = false;
  }
});
