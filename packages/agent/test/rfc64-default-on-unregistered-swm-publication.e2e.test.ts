// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEVMAdapter,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { DKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

describe('RFC-64 default-on local unregistered SWM publication', () => {
  let agent: DKGAgent | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (agent !== undefined) {
      await agent.stop().catch(() => undefined);
      await agent.store.close().catch(() => undefined);
      agent = undefined;
    }
    if (dataDir !== undefined) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
    vi.restoreAllMocks();
  });

  it('shares a FULL assertion while the durable CG remains unregistered and operation-scoped registry RPCs stay idle', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-default-unregistered-swm-'));
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    agent = await DKGAgent.create({
      name: 'Rfc64DefaultUnregisteredSwmPublisher',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      nodeRole: 'core',
      chainAdapter: chain,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      syncSharedMemoryOnConnect: false,
      syncReconcilerEnabled: false,
      syncOnConnectEnabled: false,
      durableSyncEnabled: false,
      agentProfileHeartbeatMs: 0,
      // Deliberately omit every RFC-64 activation override. With a dataDir,
      // the release default must select the catalog/Track-2 path.
    });
    await agent.start();
    // Exclude the agent's normal startup event scan from the operation-scoped
    // assertion below. The spies must cover only create + FULL SWM share.
    await agent.awaitInitialChainPoll();
    await installHardhatACKProvider(agent, chain);

    const registrySpies = [
      vi.spyOn(chain, 'createContextGraph'),
      vi.spyOn(chain, 'resolveContextGraphIdByNameHash'),
      vi.spyOn(chain, 'getContextGraphNameHash'),
      vi.spyOn(chain, 'isContextGraphActiveOnChain'),
      vi.spyOn(chain, 'getContextGraphAccessPolicy'),
      vi.spyOn(chain, 'getContextGraphPublishPolicy'),
      vi.spyOn(chain, 'getContextGraphParticipantAgents'),
      vi.spyOn(chain, 'getContextGraphAuthoritySnapshot'),
    ];
    const authorityIndexReader = chain.contextGraphAuthorityIndexRevisionReader;
    const authorityIndexSpies = authorityIndexReader === undefined
      ? []
      : [
          vi.spyOn(authorityIndexReader, 'readContextGraphAuthorityIndexRevisions'),
          ...(authorityIndexReader.readContextGraphAuthorityIndexSnapshots === undefined
            ? []
            : [vi.spyOn(authorityIndexReader, 'readContextGraphAuthorityIndexSnapshots')]),
          ...(authorityIndexReader.resolveFinalizedContextGraphIdByNameHash === undefined
            ? []
            : [vi.spyOn(authorityIndexReader, 'resolveFinalizedContextGraphIdByNameHash')]),
          ...(
            authorityIndexReader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash
              === undefined
              ? []
              : [vi.spyOn(
                  authorityIndexReader,
                  'resolveFinalizedContextGraphAuthoritySnapshotByNameHash',
                )]
          ),
          ...(authorityIndexReader.resolveFinalizedContextGraphIdsByNameHashes === undefined
            ? []
            : [vi.spyOn(authorityIndexReader, 'resolveFinalizedContextGraphIdsByNameHashes')]),
          ...(
            authorityIndexReader.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes
              === undefined
              ? []
              : [vi.spyOn(
                  authorityIndexReader,
                  'resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes',
                )]
          ),
        ];

    const contextGraphId = 'rfc64-default-on-local-unregistered-swm';
    const assertionId = 'full-share';
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'RFC-64 default local SWM publication',
    });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(agent.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      mode: 'catalog',
      active: true,
      track2Enabled: true,
      legacySyncAllowed: false,
      reconciliationLane: 'catalog-apply',
    });

    await agent.assertion.create(contextGraphId, assertionId);
    await agent.assertion.write(contextGraphId, assertionId, [{
      subject: 'urn:rfc64:default-on:entity',
      predicate: 'https://schema.org/name',
      object: '"Local unregistered FULL share"',
    }]);
    const shared = await agent.assertion.promote(contextGraphId, assertionId);

    expect(shared).toMatchObject({ sealed: true, publishReady: true });
    expect(await agent.assertion.history(contextGraphId, assertionId)).toMatchObject({
      state: 'promoted',
      status: 'swm-shared',
      swmCurrentAssertion: expect.any(String),
    });
    expect(await agent.readLocalContextGraphRegistrationStatus(contextGraphId))
      .toBe('unregistered');
    expect(await agent.isLocalFirstUnregisteredContextGraph(contextGraphId)).toBe(true);
    await agent.whenRfc64CatalogSupervisorsIdleV1();

    // Do not call getContextGraphOnChainId merely to prove absence: that API
    // is itself allowed to perform discovery. The durable marker plus a zero
    // create transaction count proves this local share never registered.
    for (const registrySpy of [...registrySpies, ...authorityIndexSpies]) {
      expect(registrySpy).not.toHaveBeenCalled();
    }
  }, 30_000);
});
