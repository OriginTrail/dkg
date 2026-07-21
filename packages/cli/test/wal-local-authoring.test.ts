import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { createWalRuntime, resolveWalRuntimeConfiguration } from '@origintrail-official/dkg-wal';
import { createDaemonWalPublisherShadowWriter } from '../src/wal-local-authoring.js';

describe('daemon WAL local-authoring composition', () => {
  it('does not touch legacy mode and makes missing parallel evidence visibly blocked', async () => {
    expect(await createDaemonWalPublisherShadowWriter({ runtime: null, networkId: 'network' }))
      .toBeUndefined();

    const home = await mkdtemp(join(tmpdir(), 'dkg-cli-wal-authoring-'));
    const runtime = createWalRuntime(resolveWalRuntimeConfiguration({
      dkgHome: home,
      sync: { mode: 'parallel' },
    }))!;
    await runtime.start();
    const log = vi.fn();
    const writer = await createDaemonWalPublisherShadowWriter({ runtime, networkId: 'network', log });
    const wallet = new ethers.Wallet(`0x${'71'.repeat(32)}`);
    await expect(writer!.write({
      kind: 'share',
      operation: 'PUT',
      contextGraphId: 'devnet-test',
      logicalAuthorAddress: wallet.address,
      logicalResource: 'urn:wal:root',
      idempotencyKey: 'share:one',
      baseQuads: [],
      resultQuads: [{
        subject: 'urn:wal:root',
        predicate: 'https://schema.org/name',
        object: '"blocked"',
        graph: 'did:dkg:context-graph:devnet-test/_shared_memory',
      }],
      signer: { address: wallet.address, signMessage: value => wallet.signMessage(value) },
    })).rejects.toMatchObject({ code: 'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED' });
    expect(runtime.localControlStore().integrityScan().objects).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('local authoring blocked'));
    await runtime.stop();
  });
});
