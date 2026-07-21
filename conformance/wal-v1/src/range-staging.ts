import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { equalBytes, hex } from './bytes.js';
import { validateRangeFrame, type RangeFrame } from './reference.js';
import { LIMITS } from './schema.js';
import { verifyWalObjectFileStreaming, type StreamingWalVerification } from './streaming-wal.js';

interface Part {
  path: string;
  offset: number;
  length: number;
  end: number;
}

interface Metadata {
  version: 1;
  walObjectId: string;
  totalObjectLength: string;
}

export interface RangeStagerOptions {
  stagingRoot: string;
  finalRoot: string;
  walObjectId: Uint8Array;
  totalObjectLength: bigint;
  quotaBytes: bigint;
  verificationBufferBytes?: number;
}

function parsePart(directory: string, name: string): Part | null {
  const match = /^(\d+)-(\d+)\.part$/.exec(name);
  if (match === null) return null;
  const offset = Number(match[1]);
  const length = Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1) return null;
  return { path: join(directory, name), offset, length, end: offset + length };
}

function coveredBytes(parts: readonly Part[]): bigint {
  const sorted = [...parts].sort((left, right) => left.offset - right.offset || left.end - right.end);
  let total = 0n;
  let start = -1;
  let end = -1;
  for (const part of sorted) {
    if (start < 0) {
      start = part.offset;
      end = part.end;
    } else if (part.offset <= end) {
      end = Math.max(end, part.end);
    } else {
      total += BigInt(end - start);
      start = part.offset;
      end = part.end;
    }
  }
  if (start >= 0) total += BigInt(end - start);
  return total;
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readSlice(part: Part, absoluteOffset: number, length: number): Promise<Uint8Array> {
  const file = await open(part.path, 'r');
  try {
    const output = new Uint8Array(length);
    const { bytesRead } = await file.read(output, 0, length, absoluteOffset - part.offset);
    if (bytesRead !== length) throw new Error('truncated staged range');
    return output;
  } finally {
    await file.close();
  }
}

export class RangeStager {
  readonly objectDirectory: string;
  readonly finalPath: string;
  readonly metadataPath: string;
  readonly #options: RangeStagerOptions;

  constructor(options: RangeStagerOptions) {
    if (options.walObjectId.length !== 32) throw new Error('WalObjectId must be bytes32');
    if (options.totalObjectLength < 1n || options.totalObjectLength > options.quotaBytes) throw new Error('advertised length exceeds staging quota');
    this.#options = { ...options, walObjectId: new Uint8Array(options.walObjectId) };
    const id = hex(options.walObjectId);
    this.objectDirectory = join(options.stagingRoot, id);
    this.finalPath = join(options.finalRoot, `${id}.wal`);
    this.metadataPath = join(this.objectDirectory, 'metadata.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.objectDirectory, { recursive: true });
    await mkdir(this.#options.finalRoot, { recursive: true });
    const metadata: Metadata = {
      version: 1,
      walObjectId: hex(this.#options.walObjectId),
      totalObjectLength: this.#options.totalObjectLength.toString()
    };
    try {
      const existing = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Metadata;
      if (
        existing.version !== metadata.version ||
        existing.walObjectId !== metadata.walObjectId ||
        existing.totalObjectLength !== metadata.totalObjectLength
      ) throw new Error('dishonest total length or cross-object resume metadata');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = `${this.metadataPath}.new`;
      await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
      const file = await open(temporary, 'r');
      await file.sync();
      await file.close();
      await rename(temporary, this.metadataPath);
      await fsyncDirectory(this.objectDirectory);
    }
  }

  async parts(): Promise<Part[]> {
    const names = await readdir(this.objectDirectory);
    const parts = names.map((name) => parsePart(this.objectDirectory, name)).filter((part): part is Part => part !== null);
    for (const part of parts) {
      const details = await stat(part.path);
      if (details.size !== part.length) throw new Error('staged range length mismatch');
    }
    return parts.sort((left, right) => left.offset - right.offset || left.length - right.length);
  }

  async accept(frame: RangeFrame): Promise<'stored' | 'duplicate'> {
    validateRangeFrame(frame);
    if (!equalBytes(frame.walObjectId, this.#options.walObjectId)) throw new Error('cross-object range');
    if (frame.totalObjectLength !== this.#options.totalObjectLength) throw new Error('dishonest total length');
    if (frame.bytes.length === 0) return 'duplicate';
    if (frame.offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('range offset exceeds platform API');
    const offset = Number(frame.offset);
    const name = `${offset}-${frame.bytes.length}.part`;
    const path = join(this.objectDirectory, name);
    try {
      const existing = new Uint8Array(await readFile(path));
      if (!equalBytes(existing, frame.bytes)) throw new Error('duplicate range bytes disagree');
      return 'duplicate';
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const proposed: Part = { path, offset, length: frame.bytes.length, end: offset + frame.bytes.length };
    const current = await this.parts();
    if (current.length >= LIMITS.stagedRangePartsPerObject) throw new Error('staged range-part limit exceeded');
    const physicalBytes = current.reduce((sum, part) => sum + BigInt(part.length), 0n) + BigInt(proposed.length);
    if (physicalBytes > this.#options.quotaBytes || coveredBytes([...current, proposed]) > this.#options.quotaBytes) {
      throw new Error('staging quota exceeded');
    }
    const file = await open(path, 'wx');
    try {
      await file.write(frame.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await fsyncDirectory(this.objectDirectory);
    return 'stored';
  }

  async isComplete(): Promise<boolean> {
    return coveredBytes(await this.parts()) === this.#options.totalObjectLength;
  }

  async promote(): Promise<StreamingWalVerification> {
    const parts = await this.parts();
    if (coveredBytes(parts) !== this.#options.totalObjectLength) throw new Error('staged object is incomplete');
    await this.#verifyOverlaps(parts);
    const assembling = join(this.objectDirectory, 'complete.assembling');
    const output = await open(assembling, 'w');
    try {
      let position = 0;
      while (position < Number(this.#options.totalObjectLength)) {
        const covering = parts.filter((part) => part.offset <= position && part.end > position);
        if (covering.length === 0) throw new Error('staged object has a gap');
        covering.sort((left, right) => right.end - left.end || left.offset - right.offset);
        const selected = covering[0];
        const length = Math.min(65_536, selected.end - position);
        const bytes = await readSlice(selected, position, length);
        await output.write(bytes);
        position += length;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const verification = await verifyWalObjectFileStreaming(
      assembling,
      this.#options.walObjectId,
      this.#options.verificationBufferBytes ?? 65_536
    );
    await rename(assembling, this.finalPath);
    await fsyncDirectory(this.#options.finalRoot);
    await rm(this.objectDirectory, { recursive: true });
    return verification;
  }

  async cancel(): Promise<void> {
    await rm(this.objectDirectory, { recursive: true, force: true });
  }

  async #verifyOverlaps(parts: readonly Part[]): Promise<void> {
    for (let leftIndex = 0; leftIndex < parts.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < parts.length; rightIndex += 1) {
        const left = parts[leftIndex];
        const right = parts[rightIndex];
        const start = Math.max(left.offset, right.offset);
        const end = Math.min(left.end, right.end);
        if (start >= end) continue;
        let position = start;
        while (position < end) {
          const length = Math.min(65_536, end - position);
          const [leftBytes, rightBytes] = await Promise.all([
            readSlice(left, position, length),
            readSlice(right, position, length)
          ]);
          if (!equalBytes(leftBytes, rightBytes)) throw new Error('overlapping ranges disagree');
          position += length;
        }
      }
    }
  }
}
