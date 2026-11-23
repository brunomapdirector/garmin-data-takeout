// ExportStore on the origin-private file system. Runs in the export Web Worker, where
// synchronous access handles are available in every current browser.

import type { ExportStore, OutputSink } from '../core/store';

// Worker-only parts of the File System API, which the DOM lib does not declare.
interface SyncHandle {
  write(data: Uint8Array, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type FileHandleWithSync = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };
type DirWithEntries = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

const JOB_DIR = 'takeout-job';
const OUT_DIR = 'takeout-output';

export class OpfsStore implements ExportStore {
  private constructor(private root: FileSystemDirectoryHandle, private out: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsStore> {
    const base = await navigator.storage.getDirectory();
    return new OpfsStore(
      await base.getDirectoryHandle(JOB_DIR, { create: true }),
      await base.getDirectoryHandle(OUT_DIR, { create: true }),
    );
  }

  private async locate(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = path.split('/');
    const name = parts.pop()!;
    let dir = this.root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return [dir, name];
  }

  async write(path: string, data: Uint8Array) {
    const [dir, name] = await this.locate(path, true);
    const fh = (await dir.getFileHandle(name, { create: true })) as FileHandleWithSync;
    const h = await fh.createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(data, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  }

  async read(path: string) {
    const [dir, name] = await this.locate(path, false);
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async has(path: string) {
    try {
      const [dir, name] = await this.locate(path, false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async list() {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, h] of (dir as DirWithEntries).entries()) {
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, prefix + name + '/');
        else out.push(prefix + name);
      }
    };
    await walk(this.root, '');
    return out;
  }

  async clear() {
    for await (const [name] of (this.root as DirWithEntries).entries()) await this.root.removeEntry(name, { recursive: true });
    await this.clearOutput();
  }

  async clearOutput() {
    for await (const [name] of (this.out as DirWithEntries).entries()) await this.out.removeEntry(name, { recursive: true });
  }

  async openOutput(name: string): Promise<OutputSink> {
    await this.clearOutput();
    const fh = (await this.out.getFileHandle(name, { create: true })) as FileHandleWithSync;
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    let at = 0;
    return {
      write(chunk) {
        at += h.write(chunk, { at });
      },
      async close() {
        h.flush();
        h.close();
        return fh.getFile(); // backed by disk, not a copy in memory
      },
    };
  }
}
