import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisherInspector } from '../src/publisher-runner.js';

describe('daemon-down publisher inspection', () => {
  it('requires the daemon for the managed oxigraph-server backend', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-managed-store-'));

    await expect(createPublisherInspector({
      dataDir,
      config: {
        name: 'managed-publisher-test',
        nodeRole: 'edge',
        store: { backend: 'oxigraph-server', options: {} },
      },
    })).rejects.toThrow(
      /daemon-managed store "oxigraph-server" require a running DKG daemon.*Start the daemon and retry/,
    );
  });
});
