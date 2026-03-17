import { describe } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StreamingScanStore } from '../src/streaming-scan-store.js';
import { runVectorStoreContract } from './store-suite.js';

describe('StreamingScanStore', () => {
  runVectorStoreContract(() => new StreamingScanStore({
    dataDir: mkdtempSync(join(tmpdir(), 'dkg-vector-stream-')),
    dimensions: 3,
  }));
});
