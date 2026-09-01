/**
 * `supportsEventTypes` and the alias families (#2435): the capability probe
 * must agree with `listenForEvents` for every public name under every ABI
 * spelling the owning contract may declare. Split from the raw-log scanning
 * suite at review r9 to mirror the production boundary.
 */
import {
  describe,
  it,
  expect,
} from 'vitest';

import {
  ethers,
} from 'ethers';
import {
  EVMChainAdapter,
} from '../src/evm-adapter.js';
import {
  KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES,
  SERVED_EVENT_TYPES,
} from '../src/evm-adapter-events.js';
import {
  KA_ABI,
  makeAdapter,
  drain,
} from './_helpers/root-mutation-scan-harness.js';

describe('EVMChainAdapter — capability probe and alias families', () => {
  describe('alias families: EVERY public name agrees with the listener under EITHER ABI spelling (review r7-bot)', () => {
    const families: Array<{
      publicNames: readonly [string, string];
      abiBase: string;
      abiAlias: string;
      scanLabelContract: string;
    }> = [
      {
        publicNames: ['KCCreated', 'KnowledgeAssetCreated'],
        abiBase: 'KnowledgeAssetCreated',
        abiAlias: 'KCCreated',
        scanLabelContract: 'kas',
      },
    ];
    for (const family of families) {
      for (const publicName of family.publicNames) {
        for (const abiSpelling of [family.abiBase, family.abiAlias]) {
          it(`${publicName} over an ABI declaring only ${abiSpelling}`, async () => {
            const abi = (KA_ABI as Array<Record<string, unknown>>).map((entry) =>
              entry.type === 'event' && entry.name === family.abiBase && abiSpelling !== family.abiBase
                ? { ...entry, name: abiSpelling }
                : entry,
            );
            const { adapter, scans } = makeAdapter({ abi });

            await expect(
              adapter.supportsEventTypes([publicName]),
              `the probe must accept ${publicName}`,
            ).resolves.toEqual([]);
            await expect(
              drain(adapter, [publicName]),
              `and listening for ${publicName} must not throw`,
            ).resolves.toEqual([]);
            expect(
              scans.map((scan) => scan.label),
              `the scan asked for the DECLARED spelling`,
            ).toContain(`${family.scanLabelContract}.queryFilter(${abiSpelling})`);
          });
        }
      }
    }

    for (const publicName of ['ContextGraphNameClaimed', 'NameClaimed']) {
      for (const abiSpelling of ['NameClaimed', 'ContextGraphNameClaimed']) {
        it(`${publicName} over a registry ABI declaring only ${abiSpelling}`, async () => {
          const registryAbi = [{
            type: 'event',
            name: abiSpelling,
            anonymous: false,
            inputs: [
              { name: 'nameHash', type: 'uint256', indexed: true },
              { name: 'creator', type: 'address', indexed: true },
              { name: 'accessPolicy', type: 'uint8', indexed: false },
            ],
          }];
          const { adapter, scans } = makeAdapter({});
          const priv = adapter as unknown as { contracts: Record<string, unknown> };
          priv.contracts.contextGraphNameRegistry = new ethers.Contract('0x' + '33'.repeat(20), registryAbi as never);

          await expect(
            adapter.supportsEventTypes([publicName]),
            `the probe must accept ${publicName}`,
          ).resolves.toEqual([]);
          await expect(
            drain(adapter, [publicName]),
            `and listening for ${publicName} must not throw`,
          ).resolves.toEqual([]);
          expect(
            scans.map((scan) => scan.label),
            `the scan asked for the DECLARED spelling`,
          ).toContain(`cgNameRegistry.queryFilter(${abiSpelling})`);
        });
      }
    }
  });

  it('probe-plus-listen agree on a fallback-only KCCreated ABI (review r5-bot)', async () => {
    // The probe accepts EITHER alias spelling; the scan branch must build
    // its filter from the SAME resolution. Before the fix this passed the
    // capability gate and then threw on the hard-coded primary fragment,
    // aborting every scan at runtime.
    const kcOnlyAbi = (KA_ABI as Array<Record<string, unknown>>).map((entry) =>
      entry.type === 'event' && entry.name === 'KnowledgeAssetCreated'
        ? { ...entry, name: 'KCCreated' }
        : entry,
    );
    const { adapter, scans } = makeAdapter({ abi: kcOnlyAbi });

    await expect(adapter.supportsEventTypes(['KCCreated']), 'the fallback spelling IS served').resolves.toEqual([]);
    await expect(drain(adapter, ['KCCreated']), 'and listening must not throw').resolves.toEqual([]);
    expect(
      scans.map((scan) => scan.label),
      'the scan asked for the spelling the ABI declares',
    ).toContain('kas.queryFilter(KCCreated)');
  });

  it('probe-plus-listen agree on a fallback-only ContextGraphNameClaimed ABI (review r5-bot)', async () => {
    const claimOnlyAbi = [{
      type: 'event',
      name: 'ContextGraphNameClaimed',
      anonymous: false,
      inputs: [
        { name: 'nameHash', type: 'uint256', indexed: true },
        { name: 'creator', type: 'address', indexed: true },
        { name: 'accessPolicy', type: 'uint8', indexed: false },
      ],
    }];
    const { adapter, scans } = makeAdapter({});
    const priv = adapter as unknown as { contracts: Record<string, unknown> };
    priv.contracts.contextGraphNameRegistry = new ethers.Contract('0x' + '33'.repeat(20), claimOnlyAbi as never);

    await expect(
      adapter.supportsEventTypes(['ContextGraphNameClaimed']),
      'the fallback spelling IS served',
    ).resolves.toEqual([]);
    await expect(drain(adapter, ['ContextGraphNameClaimed']), 'and listening must not throw').resolves.toEqual([]);
    expect(
      scans.map((scan) => scan.label),
      'the scan asked for the spelling the ABI declares',
    ).toContain('cgNameRegistry.queryFilter(ContextGraphNameClaimed)');
  });
});

describe('EVMChainAdapter.supportsEventTypes', () => {
  it('accepts EACH alias spelling independently, not only the primary (review r3-bot)', async () => {
    // Both fixtures previously carried the FIRST spelling only, so dropping
    // or mis-probing the fallback would stay green. One minimal ABI per
    // SPELLING, bound to the owning contract, each probed alone.
    const cases = [
      {
        name: 'KCCreated',
        owner: 'knowledgeAssetStorage',
        spellings: [
          { fragment: 'KnowledgeAssetCreated' },
          { fragment: 'KCCreated' },
        ],
      },
      {
        name: 'ContextGraphNameClaimed',
        owner: 'contextGraphNameRegistry',
        spellings: [
          { fragment: 'NameClaimed' },
          { fragment: 'ContextGraphNameClaimed' },
        ],
      },
    ] as const;
    for (const { name, owner, spellings } of cases) {
      for (const spelling of spellings) {
        const abi = [{
          type: 'event', name: spelling.fragment, anonymous: false,
          inputs: [{ indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' }],
        }];
        const contract = new ethers.Contract('0x' + '44'.repeat(20), abi as never);
        const { adapter } = makeAdapter({});
        (adapter as unknown as { contracts: Record<string, unknown> }).contracts[owner] = contract;

        await expect(
          adapter.supportsEventTypes([name]),
          `${name} must be supported by a ${spelling.fragment}-ONLY ABI`,
        ).resolves.toEqual([]);
      }
      // And an owning ABI with NEITHER spelling refuses the name — the
      // aliases widen acceptance, they do not disable the probe.
      const emptyAbi = [{
        type: 'event', name: 'SomethingUnrelated', anonymous: false,
        inputs: [{ indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' }],
      }];
      const bare = new ethers.Contract('0x' + '45'.repeat(20), emptyAbi as never);
      const { adapter } = makeAdapter({});
      (adapter as unknown as { contracts: Record<string, unknown> }).contracts[owner] = bare;
      await expect(adapter.supportsEventTypes([name])).resolves.toEqual([name]);
    }
  });

  it('the served roster equals an INDEPENDENTLY written vocabulary (review r3-bot)', () => {
    // SERVED_EVENT_TYPES is the implementation output; using it as the test
    // input let an omitted ownership row hide (the probe would refuse an
    // event listenForEvents still serves, while every parity assertion
    // stayed green). This roster is written BY HAND — update it only when
    // the public event vocabulary genuinely changes.
    const EXPECTED_ROSTER = [
      'KnowledgeBatchCreated',
      'ContextGraphExpanded',
      'KnowledgeAssetRegisteredToContextGraph',
      'KCCreated',
      'KnowledgeAssetCreated',
      'NameClaimed',
      'ContextGraphNameClaimed',
      'ContextGraphCreated',
      'RelayCapabilityUpdated',
      'KnowledgeAssetUpdated',
      'KnowledgeAssetMerkleRootAdded',
      'KnowledgeAssetMerkleRootsUpdated',
      'KnowledgeAssetMerkleRootRemoved',
    ];
    expect([...SERVED_EVENT_TYPES].sort()).toEqual([...EXPECTED_ROSTER].sort());
  });
  it('reports nothing missing when the bound ABI declares every name', async () => {
    const { adapter } = makeAdapter({});
    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual([]);
  });

  it('names the specific events a legacy ABI cannot produce', async () => {
    const legacyAbi = (KA_ABI as unknown[]).filter(
      (entry) => (entry as { name?: string }).name !== 'KnowledgeAssetMerkleRootRemoved',
    );
    const { adapter } = makeAdapter({ abi: legacyAbi });

    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual(['KnowledgeAssetMerkleRootRemoved']);
  });

  it('reports every name missing when no storage contract is bound', async () => {
    const { adapter } = makeAdapter({ bindStorage: false });
    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);
  });

  it('answers each name from the contract that OWNS it, not from one hard-coded binding (review r2)', async () => {
    // The first implementation asked `knowledgeAssetStorage` about every name,
    // so `ContextGraphCreated` — an event this adapter genuinely serves from
    // `contextGraphStorage` — was reported missing. The registry keys the
    // answer per event.
    const cgAbi = [{
      type: 'event', name: 'ContextGraphCreated', anonymous: false,
      inputs: [{ indexed: true, internalType: 'uint256', name: 'contextGraphId', type: 'uint256' }],
    }];
    const cgContract = new ethers.Contract('0x' + '33'.repeat(20), cgAbi as never);
    const { adapter } = makeAdapter({});
    (adapter as unknown as { contracts: Record<string, unknown> }).contracts['contextGraphStorage'] = cgContract;

    // Owned by contextGraphStorage and declared there → supported.
    await expect(adapter.supportsEventTypes(['ContextGraphCreated'])).resolves.toEqual([]);
    // Served by this adapter but its owning contract lacks the fragment → missing.
    await expect(adapter.supportsEventTypes(['ContextGraphExpanded'])).resolves.toEqual(['ContextGraphExpanded']);
    // No scan branch serves this name at all → missing, whatever any ABI says.
    await expect(adapter.supportsEventTypes(['NoSuchEventAnywhere'])).resolves.toEqual(['NoSuchEventAnywhere']);
    // Mixed probe: each name judged independently.
    await expect(
      adapter.supportsEventTypes(['ContextGraphCreated', 'KnowledgeAssetUpdated', 'NoSuchEventAnywhere']),
    ).resolves.toEqual(['NoSuchEventAnywhere']);
    // r6 divergence row: both public spellings of the name-claim event are
    // served from ContextGraphNameRegistry, whose ABI spells the fragment
    // `NameClaimed` — the probe must answer BOTH spellings as supported.
    const nameAbi = [{
      type: 'event', name: 'NameClaimed', anonymous: false,
      inputs: [{ indexed: true, internalType: 'bytes32', name: 'nameHash', type: 'bytes32' }],
    }];
    const registry = new ethers.Contract('0x' + '44'.repeat(20), nameAbi as never);
    (adapter as unknown as { contracts: Record<string, unknown> }).contracts['contextGraphNameRegistry'] = registry;
    await expect(adapter.supportsEventTypes(['NameClaimed', 'ContextGraphNameClaimed'])).resolves.toEqual([]);
    // Served name whose ABI FRAGMENT is spelled differently (review r3):
    // `listenForEvents` serves the public name `KCCreated` by scanning the
    // greenfield `KnowledgeAssetCreated` fragment, so the probe must accept
    // the alias — a literal-fragment probe reports a served event missing.
    await expect(adapter.supportsEventTypes(['KCCreated'])).resolves.toEqual([]);
  });
});
