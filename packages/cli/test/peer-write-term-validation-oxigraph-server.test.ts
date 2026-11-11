/**
 * The peer write term scenarios of the publisher's
 * `test/peer-write-term-validation.test.ts` on the pinned oxigraph-server the
 * daemon manages: a term the RDF grammar does not allow is refused before it
 * reaches the store, and nothing is written. `DKG_OXIGRAPH_TEST_BINARY` names
 * a local binary; otherwise the pinned release is resolved, as in
 * `oxigraph-server-native.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '@origintrail-official/dkg-storage';
import * as publisher from '@origintrail-official/dkg-publisher';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { resolveOxigraphBinary } from '../src/daemon/oxigraph-binary.js';
import { freePort } from './fixtures/oxigraph-server-real-fixture.js';
import { describePeerWriteTermValidation } from '../../publisher/test/_helpers/peer-write-terms.js';

let server: Awaited<ReturnType<typeof startOxigraphServer>> | undefined;
let location: string | undefined;
let endpoint = '';

beforeAll(async () => {
  const binaryPath = process.env.DKG_OXIGRAPH_TEST_BINARY ?? (await resolveOxigraphBinary({
    cacheDir: join(tmpdir(), 'dkg-required-oxigraph-test-binary'),
    log: () => {},
  })).path;
  location = await mkdtemp(join(tmpdir(), 'oxi-peer-write-terms-'));
  const port = await freePort();
  server = await startOxigraphServer({
    binaryPath,
    location,
    port,
    readyTimeoutMs: 10_000,
    readyIntervalMs: 50,
    stopGraceMs: 2_000,
    restartBackoffBaseMs: 100,
    restartBackoffMaxMs: 200,
    log: () => {},
  });
  endpoint = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (location) await rm(location, { recursive: true, force: true });
}, 30_000);

describePeerWriteTermValidation({
  name: 'the pinned oxigraph-server',
  async open() {
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: `${endpoint}/query`,
      updateEndpoint: `${endpoint}/update`,
      timeout: 10_000,
    });
    return { store, dispose: () => store.close() };
  },
}, publisher);
