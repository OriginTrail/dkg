import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SyncVerifyLogEntry {
  level: 'debug' | 'warn';
  message: string;
}

export interface SyncVerifyResult {
  data: Quad[];
  meta: Quad[];
  rejected: number;
  logs: SyncVerifyLogEntry[];
}

export interface SyncParseResult {
  quads: Quad[];
  totalQuads: number;
}

export interface SharedMemoryProcessResult {
  validQuads: Quad[];
  dropped: number;
  entityCreators: Array<[string, string]>;
}

export interface SharedMemoryBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  droppedDataTriples: number;
  emptyResponses: number;
  entityCreators: Array<[string, string]>;
}

export interface DurableBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  rejectedKcs: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  logs: SyncVerifyLogEntry[];
}

export class SyncVerifyWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    const jsWorkerUrl = new URL('./sync-verify-worker-impl.js', import.meta.url);
    const tsWorkerUrl = new URL('./sync-verify-worker-impl.ts', import.meta.url);
    const workerUrl = existsSync(fileURLToPath(jsWorkerUrl)) ? jsWorkerUrl : tsWorkerUrl;
    this.worker = new Worker(fileURLToPath(workerUrl));
    this.worker.on('message', (message: { id: number; result?: SyncVerifyResult; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
    });
  }

  verify(dataQuads: Quad[], metaQuads: Quad[], acceptUnverified: boolean): Promise<SyncVerifyResult> {
    const id = this.nextId++;
    return new Promise<SyncVerifyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'verify', args: [dataQuads, metaQuads, acceptUnverified] });
    });
  }

  parseAndFilter(nquadsText: string, graphUri: string, contextGraphId: string): Promise<SyncParseResult> {
    const id = this.nextId++;
    return new Promise<SyncParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'parseAndFilter', args: [nquadsText, graphUri, contextGraphId] });
    });
  }

  processSharedMemory(wsDataQuads: Quad[], wsMetaQuads: Quad[]): Promise<SharedMemoryProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processSharedMemory', args: [wsDataQuads, wsMetaQuads] });
    });
  }

  processDurableBatch(
    dataQuads: Quad[],
    metaQuads: Quad[],
    acceptUnverified: boolean,
  ): Promise<DurableBatchProcessResult> {
    const id = this.nextId++;
    return new Promise<DurableBatchProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processDurableBatch', args: [dataQuads, metaQuads, acceptUnverified] });
    });
  }

  processSharedMemoryBatch(
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
  ): Promise<SharedMemoryBatchProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryBatchProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processSharedMemoryBatch', args: [wsDataQuads, wsMetaQuads] });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
