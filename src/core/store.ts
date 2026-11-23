// Where an export keeps its files while it runs. In the browser: the origin-private
// file system (OPFS), so a closed tab can resume and big exports never sit in memory.
// In Node scripts: a folder on disk. Paths are relative, '/'-separated.

export interface OutputSink {
  /** Called synchronously by the zip writer, chunk by chunk. */
  write(chunk: Uint8Array): void;
  /** Finish the file and return it (disk-backed in the browser, not a copy in memory). */
  close(): Promise<Blob>;
}

export interface ExportStore {
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  has(path: string): Promise<boolean>;
  /** Every stored path, recursively. */
  list(): Promise<string[]>;
  /** Remove everything (a new export, or after the user saved the zip). */
  clear(): Promise<void>;
  /** A file outside the export's own paths, for the finished zip. */
  openOutput(name: string): Promise<OutputSink>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const writeJson = (s: ExportStore, path: string, v: unknown) => s.write(path, enc.encode(JSON.stringify(v, null, 2)));
export const writeText = (s: ExportStore, path: string, t: string) => s.write(path, enc.encode(t));
export const readJson = async <T = unknown>(s: ExportStore, path: string): Promise<T> => JSON.parse(dec.decode(await s.read(path)));
