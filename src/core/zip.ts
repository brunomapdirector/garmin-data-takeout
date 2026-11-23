// Stream every stored file into one zip, one file at a time, so memory stays at the
// size of a single file whatever the export's total size.

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { ExportStore, OutputSink } from './store';

export async function zipStore(
  store: ExportStore,
  paths: string[],
  root: string,
  sink: OutputSink,
  onFile: (done: number, total: number) => void,
): Promise<Blob> {
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else sink.write(chunk);
  });
  let done = 0;
  for (const path of paths) {
    const data = await store.read(path);
    // FIT files and zips barely compress; store them as they are.
    const entry = /\.(fit|zip|gz)$/i.test(path) ? new ZipPassThrough(root + path) : new ZipDeflate(root + path, { level: 6 });
    zip.add(entry);
    entry.push(data, true);
    if (failure) throw failure;
    onFile(++done, paths.length);
  }
  zip.end();
  if (failure) throw failure;
  return sink.close();
}
