import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableDirectoryPreparation } from './durable-content-addressed-file.js';
import { persistFileDirectoryEntries } from './file-durability.js';
import { readLiteralBlobBounded } from './bounded-literal-hydration.js';

/** The legacy hash-file layout, also used by the offline rollback exporter. */
export class LiteralBlobFileOwner {
  private readonly directory: DurableDirectoryPreparation;
  constructor(private readonly path: string) { this.directory = new DurableDirectoryPreparation(path); }

  async write(hash: string, term: string): Promise<void> {
    this.assertHash(hash);
    if (this.hash(term) !== hash) throw new Error(`Literal blob integrity mismatch for ${hash}`);
    await this.directory.prepare();
    const path = join(this.path, hash);
    let file;
    try { file = await open(path, 'wx'); }
    catch (error) {
      if (!this.isError(error, 'EEXIST')) throw error;
      await this.read(hash);
      file = await open(path, 'r+');
    }
    try {
      // Re-submit verified bytes and sync their writer; a fresh fd can miss old EIO.
      await file.writeFile(term, 'utf8'); await file.sync();
    } finally { await file.close(); }
    await persistFileDirectoryEntries(path);
  }

  async read(hash: string, constraints?: { maxBytes?: number; signal?: AbortSignal }): Promise<string> {
    this.assertHash(hash);
    const path = join(this.path, hash);
    let content: string;
    try {
      constraints?.signal?.throwIfAborted();
      content = constraints?.maxBytes === undefined
        ? await readFile(path, { encoding: 'utf8', signal: constraints?.signal })
        : await readLiteralBlobBounded(path, constraints.maxBytes, constraints.signal);
      constraints?.signal?.throwIfAborted();
    } catch (error) {
      if (this.isError(error, 'ENOENT')) throw new Error(`SWM external literal blob missing for sha256:${hash} at ${path}`);
      throw error;
    }
    const actual = this.hash(content);
    if (actual !== hash) throw new Error(`SWM external literal blob corrupt for sha256:${hash} at ${path}: found sha256:${actual}`);
    return content;
  }
  private hash(term: string): string { return createHash('sha256').update(term).digest('hex'); }
  private assertHash(hash: string): void { if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`Invalid sha256 literal blob key: ${hash}`); }
  private isError(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code; }
}
