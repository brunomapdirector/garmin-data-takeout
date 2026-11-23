const out = document.getElementById('out')!;
const w = new Worker(new URL('./opfs-selftest.worker.ts', import.meta.url), { type: 'module' });
w.onmessage = (e: MessageEvent<Array<[string, boolean, string?]>>) => {
  out.innerHTML = e.data
    .map(([n, ok, d]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? 'ok' : 'FAIL'}: ${n}${d ? ` <small>(${d})</small>` : ''}</li>`)
    .join('');
  document.title = e.data.every(([, ok]) => ok) ? 'PASS' : 'FAIL';
};
w.onerror = (e) => {
  out.innerHTML = `<li class="bad">worker error: ${e.message}</li>`;
  document.title = 'FAIL';
};
