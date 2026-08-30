import {
  DKGAgent,
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
  type DKGAgentConfig,
  type ReplicationEvent,
  type Rfc64PublicCatalogActivationInputV1,
} from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  assertCanonicalEvmAddress,
  assertCanonicalDigest,
  assertContextGraphIdV1,
  assertUnsignedContextGraphPolicyEnvelopeV1,
  computeNetworkId,
  createOperationContext,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  tryReplaceGraphAtomically,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import {
  GATE1_ASSERTION_ROOT,
  GATE1_AUTHOR_ADDRESS,
  GATE1_DEPLOYMENT,
  GATE1_KA_ID,
  GATE1_KA_UAL,
  GATE1_NETWORK_ID,
  GATE1_PROJECTION_NQUADS,
  GATE1_PROJECTION_QUADS,
} from './fixture.js';
import {
  GATE1_VM_CHAIN_READ_KEYS,
  isGate1RolloutCommand,
  parseGate1RolloutCommandInput,
  type Gate1ReplicationEvent,
  type Gate1RolloutCommand,
  type Gate1RolloutCommandInput,
  type Gate1RolloutCommandOutput,
  type Gate1RolloutMode,
  type Gate1VmReconcileResult,
  type Gate1VmChainReadCounts,
  type Gate1VmChainScenario,
} from './rollout-process-protocol.js';

export interface Gate1RolloutAdapterConfig {
  readonly completeSwmProvider: string | undefined;
  readonly contextGraphId: ContextGraphIdV1;
  readonly killSwitch: boolean;
  readonly mode: Gate1RolloutMode;
  readonly ownerAddress: EvmAddressV1;
  readonly vmChainScenario: Gate1VmChainScenario;
}

type Gate1RolloutAgentOptions = Readonly<
  Pick<
    DKGAgentConfig,
    | 'networkIdentity'
    | 'onReplicationEvent'
    | 'rfc64PublicCatalogActivation'
    | 'syncReconcilerEnabled'
  >
  & Partial<Pick<DKGAgentConfig, 'chainAdapter'>>
>;

type Gate1RolloutCommandHandlerMap = {
  readonly [K in Gate1RolloutCommand]: (
    currentAgent: DKGAgent,
    input: Gate1RolloutCommandInput<K>,
  ) => Promise<Gate1RolloutCommandOutput<K>>;
};

export function parseGate1RolloutAdapterConfig(
  env: NodeJS.ProcessEnv,
): Gate1RolloutAdapterConfig | null {
  const mode = parseRolloutMode(env.DKG_RFC64_ROLLOUT_MODE);
  const killSwitch = parseBooleanEnvironment(
    env.DKG_RFC64_ROLLOUT_KILL_SWITCH,
    'DKG_RFC64_ROLLOUT_KILL_SWITCH',
  );
  if (mode === null) {
    if (killSwitch) throw new Error('rollout kill switch requires DKG_RFC64_ROLLOUT_MODE');
    return null;
  }
  const contextGraphId = env.DKG_RFC64_ROLLOUT_CONTEXT_GRAPH_ID;
  const ownerAddress = env.DKG_RFC64_ROLLOUT_OWNER_ADDRESS?.toLowerCase();
  if (
    contextGraphId === undefined
    || ownerAddress === undefined
    || !/^0x[0-9a-f]{40}$/u.test(ownerAddress)
  ) {
    throw new Error(
      'rollout mode requires DKG_RFC64_ROLLOUT_CONTEXT_GRAPH_ID and a lowercase EVM owner',
    );
  }
  assertContextGraphIdV1(contextGraphId, 'rollout contextGraphId');
  assertCanonicalEvmAddress(ownerAddress, 'rollout owner address');
  return Object.freeze({
    completeSwmProvider: env.DKG_RFC64_ROLLOUT_COMPLETE_SWM_PROVIDER,
    contextGraphId,
    killSwitch,
    mode,
    ownerAddress,
    vmChainScenario: parseVmChainScenario(env.DKG_RFC64_ROLLOUT_VM_CHAIN_SCENARIO),
  });
}

export function buildGate1RolloutActivation(
  config: Gate1RolloutAdapterConfig,
): Rfc64PublicCatalogActivationInputV1 {
  const policy = buildOpenOwnerContextGraphPolicyV1({
    networkId: GATE1_DEPLOYMENT.networkId,
    contextGraphId: config.contextGraphId,
    ownerAddress: config.ownerAddress,
  });
  const policyEnvelope = unsignedOpenContextGraphPolicyEnvelopeV1(policy);
  assertUnsignedContextGraphPolicyEnvelopeV1(policyEnvelope);
  const activation = {
    deploymentProfile: GATE1_DEPLOYMENT,
    bootstrap: {
      acceptedPublicPolicies: [{
        policyEnvelope,
        targets: [],
        ...(config.completeSwmProvider === undefined
          ? {}
          : { completeSwmProviders: [config.completeSwmProvider] }),
      }],
    },
    rollout: {
      killSwitch: config.killSwitch,
      contextGraphModes: { [config.contextGraphId]: config.mode },
    },
  } satisfies Rfc64PublicCatalogActivationInputV1;
  return Object.freeze(activation);
}

/**
 * Rollout-only adapter support. The shared process adapter owns process I/O;
 * this fixture owns activation, chain instrumentation, event accounting, and
 * deterministic SWM setup used by the transition certificate.
 */
export class Gate1RolloutAdapterFixture {
  readonly activation: Rfc64PublicCatalogActivationInputV1;
  readonly agentOptions: Gate1RolloutAgentOptions;
  readonly vmChain: Gate1VmChainAdapter | undefined;
  readonly #replicationEvents: Gate1ReplicationEvent[] = [];
  readonly #handlers: Gate1RolloutCommandHandlerMap;

  private constructor(
    readonly config: Gate1RolloutAdapterConfig,
    readonly store: TripleStore,
    vmChain: Gate1VmChainAdapter | undefined,
    networkId: string,
  ) {
    this.activation = buildGate1RolloutActivation(config);
    this.vmChain = vmChain;
    this.agentOptions = Object.freeze({
      networkIdentity: {
        networkId,
        chainId: GATE1_DEPLOYMENT.networkId,
      },
      onReplicationEvent: this.onReplicationEvent,
      rfc64PublicCatalogActivation: this.activation,
      syncReconcilerEnabled: vmChain !== undefined,
      ...(vmChain === undefined ? {} : { chainAdapter: vmChain }),
    });
    this.#handlers = Object.freeze({
      rolloutStatus: async (currentAgent, input) => {
        const manualSwmPlan = await currentAgent.planSharedMemorySyncContextGraphs(
          input.completeProviderPeerId,
          [input.contextGraphId],
          createOperationContext('sync'),
          { requireCompleteProviderMatch: true },
        );
        return Object.freeze({
          bootstrapStarted:
            currentAgent.readRfc64PublicCatalogBootstrapStatusV1() !== null,
          catalogServiceStarted:
            currentAgent.rfc64PublicCatalogStatsV1()?.started === true,
          legacyConfiguredScope:
            currentAgent.getSyncContextGraphIds().includes(input.contextGraphId),
          manualLegacySwmTargetCount: manualSwmPlan.targets.length,
          vmChainInventorySelected:
            currentAgent.isRfc64SelectedVmReconcileContextGraph(input.contextGraphId),
        });
      },
      vmReconcile: (currentAgent, input) => (
        this.reconcileVm(currentAgent, input.contextGraphId)
      ),
      seedVmSourceSwm: (currentAgent, input) => (
        this.seedVmSourceSwm(currentAgent, input.contextGraphId)
      ),
      stagedHeadReadback: async (currentAgent, input) => {
        assertCanonicalDigest(input.objectDigest, 'stagedHeadReadback.objectDigest');
        assertCanonicalDigest(
          input.signatureVariantDigest,
          'stagedHeadReadback.signatureVariantDigest',
        );
        return currentAgent.readRfc64StagedAuthorCatalogHeadV1({
          objectDigest: input.objectDigest as Digest32V1,
          signatureVariantDigest: input.signatureVariantDigest as Digest32V1,
        });
      },
    });
  }

  static async create(
    config: Gate1RolloutAdapterConfig,
    role: 'author' | 'receiver',
    store: TripleStore,
  ): Promise<Gate1RolloutAdapterFixture> {
    const vmChain = role === 'receiver'
      ? await Gate1VmChainAdapter.create(config.contextGraphId, config.vmChainScenario)
      : undefined;
    return new Gate1RolloutAdapterFixture(
      config,
      store,
      vmChain,
      await computeNetworkId(),
    );
  }

  readonly onReplicationEvent = (event: ReplicationEvent): void => {
    this.#replicationEvents.push(Object.freeze({
      action: event.action,
      contextGraphId: event.contextGraphId,
      ...(event.ordinal === undefined ? {} : { ordinal: event.ordinal }),
    }));
  };

  supportsCommand(command: string): command is Gate1RolloutCommand {
    return isGate1RolloutCommand(command);
  }

  async dispatch<K extends Gate1RolloutCommand>(
    currentAgent: DKGAgent,
    command: K,
    rawInput: unknown,
  ): Promise<Gate1RolloutCommandOutput<K>> {
    const input = parseGate1RolloutCommandInput(command, rawInput);
    return this.#handlers[command](currentAgent, input);
  }

  async reconcileVm(
    agent: DKGAgent,
    contextGraphId: string,
  ): Promise<Gate1VmReconcileResult> {
    const chain = this.vmChain;
    if (chain === undefined) throw new Error('rollout VM chain fixture is unavailable');
    const readsBefore = chain.snapshotReadCounts();
    const eventCursor = this.#replicationEvents.length;
    const result = await agent.runVmReconcileForCg(contextGraphId, 'manual');
    return Object.freeze({
      chainReadDelta: subtractGate1VmChainReadCounts(
        chain.snapshotReadCounts(),
        readsBefore,
      ),
      replicationEvents: this.#replicationEvents.slice(eventCursor),
      result,
    });
  }

  async seedVmSourceSwm(
    agent: DKGAgent,
    contextGraphId: string,
  ): Promise<Readonly<{ swmGraph: string; tripleCount: number }>> {
    return seedGate1VmSourceSwm(agent, this.store, contextGraphId);
  }
}

/** Deterministic chain-owned VM inventory used by every receiver restart. */
export class Gate1VmChainAdapter extends MockChainAdapter {
  readonly #readCounts: Record<keyof Gate1VmChainReadCounts, number> = Object.fromEntries(
    GATE1_VM_CHAIN_READ_KEYS.map((key) => [key, 0]),
  ) as Record<keyof Gate1VmChainReadCounts, number>;

  private constructor(readonly scenario: Gate1VmChainScenario) {
    super(GATE1_NETWORK_ID, GATE1_AUTHOR_ADDRESS);
  }

  static async create(
    contextGraphId: string,
    scenario: Gate1VmChainScenario,
  ): Promise<Gate1VmChainAdapter> {
    const chain = new Gate1VmChainAdapter(scenario);
    const registered = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    });
    chain.__registerKC({
      kaId: BigInt(GATE1_KA_ID),
      contextGraphId: registered.contextGraphId,
      merkleRootHex: GATE1_ASSERTION_ROOT,
      chunks: [],
      merkleLeafCount: 2,
      byteSize: BigInt(Buffer.byteLength(GATE1_PROJECTION_NQUADS)),
      publisherAddress: GATE1_AUTHOR_ADDRESS,
    });
    return chain;
  }

  snapshotReadCounts(): Gate1VmChainReadCounts {
    return Object.freeze({ ...this.#readCounts });
  }

  override async resolveContextGraphIdByNameHash(nameHash: string): Promise<bigint | null> {
    this.#readCounts.nameHashResolution += 1;
    return super.resolveContextGraphIdByNameHash(nameHash);
  }

  override async getContextGraphKCCount(contextGraphId: bigint): Promise<bigint> {
    this.#readCounts.count += 1;
    return super.getContextGraphKCCount(contextGraphId);
  }

  override async getContextGraphKCAt(contextGraphId: bigint, index: bigint): Promise<bigint> {
    this.#readCounts.kaAt += 1;
    return super.getContextGraphKCAt(contextGraphId, index);
  }

  override async getDKGKnowledgeAssetsAddress(): Promise<string> {
    this.#readCounts.storageAddress += 1;
    return GATE1_AUTHOR_ADDRESS;
  }

  override async getLatestMerkleRoot(kaId: bigint): Promise<Uint8Array> {
    this.#readCounts.latestRoot += 1;
    return super.getLatestMerkleRoot(kaId);
  }

  override async getMerkleRootCount(kaId: bigint): Promise<bigint> {
    this.#readCounts.rootCount += 1;
    const count = await super.getMerkleRootCount(kaId);
    return this.scenario === 'root-count-drift' ? count + 1n : count;
  }

  override async getLatestMerkleRootPublisher(kaId: bigint): Promise<string> {
    this.#readCounts.publisher += 1;
    return super.getLatestMerkleRootPublisher(kaId);
  }

  override async getLatestMerkleRootAuthor(kaId: bigint): Promise<string> {
    this.#readCounts.author += 1;
    return super.getLatestMerkleRootAuthor(kaId);
  }

  override async isContextGraphActiveOnChain(contextGraphId: bigint): Promise<boolean> {
    this.#readCounts.active += 1;
    return this.scenario === 'inactive'
      ? false
      : super.isContextGraphActiveOnChain(contextGraphId);
  }

  override async getContextGraphAccessPolicy(contextGraphId: bigint): Promise<number> {
    this.#readCounts.accessPolicy += 1;
    return this.scenario === 'private'
      ? 1
      : super.getContextGraphAccessPolicy(contextGraphId);
  }
}

export function subtractGate1VmChainReadCounts(
  current: Gate1VmChainReadCounts,
  previous: Gate1VmChainReadCounts,
): Gate1VmChainReadCounts {
  return Object.freeze(Object.fromEntries(GATE1_VM_CHAIN_READ_KEYS.map((key) => (
    [key, current[key] - previous[key]]
  ))) as Record<keyof Gate1VmChainReadCounts, number>);
}

export async function seedGate1VmSourceSwm(
  agent: DKGAgent,
  store: TripleStore,
  contextGraphId: string,
): Promise<Readonly<{ swmGraph: string; tripleCount: number }>> {
  const scope = createGraphKnowledgeAssetScope(GATE1_KA_UAL, '1');
  const graphManager = new GraphManager(store);
  const swmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
  );
  const replaced = await tryReplaceGraphAtomically(
    store,
    swmGraph,
    GATE1_PROJECTION_QUADS.map((quad) => ({ ...quad, graph: swmGraph })),
  );
  if (!replaced) throw new Error('rollout store does not support atomic graph replacement');
  const shareOperationId = 'rfc64-rollout-vm-source-v1';
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId,
    shareOperationId,
    kaUal: GATE1_KA_UAL,
    assertionVersion: '1',
    quads: GATE1_PROJECTION_QUADS,
    privateTripleCount: 0,
    publisherPeerId: agent.peerId,
    accessPolicy: 'public',
    agentAddress: GATE1_AUTHOR_ADDRESS,
    timestamp: new Date('2026-07-19T12:34:56.789Z'),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId,
    kaUal: GATE1_KA_UAL,
    assertionVersion: '1',
    shareOperationId,
  });
  return Object.freeze({ swmGraph, tripleCount: GATE1_PROJECTION_QUADS.length });
}

function parseRolloutMode(input: string | undefined): Gate1RolloutMode | null {
  if (input === undefined || input === '') return null;
  if (input === 'legacy' || input === 'shadow' || input === 'catalog') return input;
  throw new Error('DKG_RFC64_ROLLOUT_MODE must be legacy, shadow, or catalog');
}

function parseVmChainScenario(input: string | undefined): Gate1VmChainScenario {
  if (input === undefined || input === '' || input === 'valid') return 'valid';
  if (input === 'inactive' || input === 'private' || input === 'root-count-drift') return input;
  throw new Error(
    'DKG_RFC64_ROLLOUT_VM_CHAIN_SCENARIO must be valid, inactive, private, or root-count-drift',
  );
}

function parseBooleanEnvironment(input: string | undefined, label: string): boolean {
  if (input === undefined || input === '' || input === '0' || input === 'false') return false;
  if (input === '1' || input === 'true') return true;
  throw new Error(`${label} must be true, false, 1, or 0`);
}
