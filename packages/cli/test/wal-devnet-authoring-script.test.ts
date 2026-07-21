import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { createWalRuntime, resolveWalRuntimeConfiguration } from '@origintrail-official/dkg-wal';
import { createDaemonWalPublisherShadowWriter } from '../src/wal-local-authoring.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('devnet WAL signed local-authoring provisioning', () => {
  it('generates explicit signed evidence that the daemon admits and uses', async () => {
    const nodeDir = await mkdtemp(join(tmpdir(), 'dkg-wal-devnet-bundle-'));
    const admin = new ethers.Wallet(`0x${'81'.repeat(32)}`);
    const writer = new ethers.Wallet(`0x${'82'.repeat(32)}`);
    await writeFile(join(nodeDir, 'config.json'), JSON.stringify({ sync: { mode: 'parallel' } }));
    await writeFile(join(nodeDir, 'wallets.json'), JSON.stringify({
      adminWallet: { privateKey: admin.privateKey, address: admin.address },
      wallets: [{ privateKey: writer.privateKey, address: writer.address }],
    }));
    const result = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      join(repoRoot, 'scripts/wal-devnet-authoring-bundle.ts'),
      '--node-dir', nodeDir,
      '--genesis-id', 'base-testnet',
      '--context-graphs', 'devnet-test,devnet-isolation',
    ], { cwd: repoRoot });
    const receipt = JSON.parse(result.stdout) as {
      networkId: string;
      curatorAuthoritySetId: string;
      views: string[];
    };
    expect(receipt.views).toEqual(['devnet-test', 'devnet-isolation']);
    const config = JSON.parse(await readFile(join(nodeDir, 'config.json'), 'utf8')) as {
      sync: { mode: 'parallel'; wal: { localAuthoring: {
        bundlePath: string;
        curatorAuthoritySetId: string;
      } } };
    };
    expect(config.sync.wal.localAuthoring).toEqual({
      bundlePath: 'local-authoring.json',
      curatorAuthoritySetId: receipt.curatorAuthoritySetId,
    });

    const runtime = createWalRuntime(resolveWalRuntimeConfiguration({
      dkgHome: nodeDir,
      sync: config.sync,
    }))!;
    await runtime.start();
    const shadow = await createDaemonWalPublisherShadowWriter({
      runtime,
      networkId: receipt.networkId,
    });
    const authored = await shadow!.write({
      kind: 'share',
      operation: 'PUT',
      contextGraphId: 'devnet-test',
      logicalAuthorAddress: writer.address,
      logicalResource: 'urn:wal:generated-bundle-root',
      idempotencyKey: 'share:generated:root',
      baseQuads: [],
      resultQuads: [{
        subject: 'urn:wal:generated-bundle-root',
        predicate: 'https://schema.org/name',
        object: '"generated"',
        graph: 'did:dkg:context-graph:devnet-test/_shared_memory',
      }],
      signer: { address: writer.address, signMessage: value => writer.signMessage(value) },
    });
    expect(authored).toMatchObject({ walStatus: 'committed', sequence: '0', objectCount: '1' });
    // Two policy atoms (one per configured graph) plus one content atom.
    expect(runtime.localControlStore().integrityScan().objects).toBe(3);
    await runtime.stop();
  }, 30_000);
});
