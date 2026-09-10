import {
  createStrictCurrentFinalizedEvmSnapshotScopeV1,
  MockChainAdapter,
  MOCK_DEFAULT_SIGNER,
  type ContextGraphAuthoritySnapshot,
  type FinalizedChainReadOwnerV1,
  type FinalizedEvmReadBindingV1,
} from '@origintrail-official/dkg-chain';
import {
  assertCanonicalChainId,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

/** Finalized authority inputs needed before any VM inventory is considered. */
export interface FinalizedChainLoopbackFixtureConfigV1 {
  readonly accessPolicy: 0 | 1;
  readonly active: boolean;
  readonly assertedAtChainId: string;
  readonly assertedAtKav10Address: EvmAddressV1;
  readonly blockHash: Digest32V1;
  readonly blockNumberQuantity: string;
  readonly contextGraphStorageAddress: EvmAddressV1;
  readonly nameHash: Digest32V1;
  readonly networkId: NetworkIdV1;
  readonly onChainContextGraphId: string;
  readonly ownerAddress: EvmAddressV1;
  readonly publishPolicy: 0 | 1;
}

export interface FinalizedChainLoopbackRpcCallV1 {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface FinalizedChainLoopbackRpcV1 {
  readonly calls: readonly FinalizedChainLoopbackRpcCallV1[];
  respond(method: string, params: readonly unknown[]): unknown;
}

export const FINALIZED_CONTEXT_GRAPH_INTERFACE = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function isContextGraphActive(uint256 contextGraphId) view returns (bool)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
  'function getContextGraphKaAt(uint256 contextGraphId, uint256 ordinal) view returns (uint256)',
]);
/** Mock adapter whose chain identity matches the loopback finalized-RPC lane. */
export class FinalizedChainLoopbackMockChainAdapterV1 extends MockChainAdapter {
  protected readonly fixture: FinalizedChainLoopbackFixtureConfigV1;
  protected readonly rpcEndpoint: string;

  constructor(fixture: FinalizedChainLoopbackFixtureConfigV1, rpcEndpoint: string) {
    super(fixture.networkId, MOCK_DEFAULT_SIGNER, {
      initialContextGraphId: BigInt(fixture.onChainContextGraphId),
    });
    if (typeof rpcEndpoint !== 'string' || rpcEndpoint.trim() === '') {
      throw new Error('Finalized chain loopback adapter requires its RPC endpoint');
    }
    this.fixture = fixture;
    this.rpcEndpoint = rpcEndpoint;
  }

  async createFinalizedEvmReadBinding(
    owner: FinalizedChainReadOwnerV1,
  ): Promise<Readonly<FinalizedEvmReadBindingV1>> {
    const chainId = this.fixture.assertedAtChainId;
    assertCanonicalChainId(chainId, 'finalized chain fixture chainId');
    return Object.freeze({
      chainId,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId, endpoints: [this.rpcEndpoint], owner,
      }),
    });
  }

  override async getEvmChainId(): Promise<bigint> {
    return BigInt(this.fixture.assertedAtChainId);
  }

  override async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return this.fixture.assertedAtKav10Address;
  }

  override async getContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
  ): Promise<ContextGraphAuthoritySnapshot> {
    if (contextGraphId.toString(10) !== this.fixture.onChainContextGraphId) {
      throw new Error(`Finalized chain fixture has no Context Graph ${contextGraphId.toString(10)}`);
    }
    return Object.freeze({
      chainId: this.fixture.assertedAtChainId,
      governanceContract: this.fixture.contextGraphStorageAddress.toLowerCase(),
      contextGraphId: this.fixture.onChainContextGraphId,
      owner: this.fixture.ownerAddress.toLowerCase(),
      active: this.fixture.active,
      accessPolicy: this.fixture.accessPolicy,
      publishPolicy: this.fixture.publishPolicy,
      publishAuthority: this.fixture.publishPolicy === 1
        ? null
        : this.fixture.ownerAddress.toLowerCase(),
      publishAuthorityAccountId: '0',
      participantAgents: Object.freeze([]),
      nameHash: this.fixture.nameHash.toLowerCase(),
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
      sourceBlockNumber: BigInt(this.fixture.blockNumberQuantity).toString(10),
      sourceBlockHash: this.fixture.blockHash.toLowerCase(),
    });
  }
}

export interface FinalizedChainLoopbackContractCallV1 {
  readonly target: string;
  readonly data: string;
}

/** Shared protocol driver; each composition supplies its complete eth_call handler. */
export function createFinalizedChainLoopbackRpcDriverV1(
  fixture: FinalizedChainLoopbackFixtureConfigV1,
  readContract: (call: FinalizedChainLoopbackContractCallV1) => string,
): FinalizedChainLoopbackRpcV1 {
  const calls: FinalizedChainLoopbackRpcCallV1[] = [];
  return Object.freeze({
    calls,
    respond(method: string, params: readonly unknown[]): unknown {
      calls.push(Object.freeze({ method, params: Object.freeze([...params]) }));
      switch (method) {
        case 'eth_chainId': return ethers.toQuantity(BigInt(fixture.assertedAtChainId));
        case 'eth_getBlockByNumber': return { number: fixture.blockNumberQuantity, hash: fixture.blockHash };
        case 'eth_getCode': return '0x6000';
        case 'eth_call': {
          const call = plainRecord(params[0], 'finalized chain eth_call object');
          const target = requiredString(call.to, 'finalized chain eth_call target').toLowerCase();
          const data = requiredString(call.data, 'finalized chain eth_call data');
          return data === '0x' ? '0x' : readContract({ target, data });
        }
        default: throw new Error(`unexpected finalized chain JSON-RPC method ${method}`);
      }
    },
  });
}

/** Policy-only authority advertises an empty Context Graph inventory. */
export function createFinalizedChainLoopbackRpcV1(
  fixture: FinalizedChainLoopbackFixtureConfigV1,
): FinalizedChainLoopbackRpcV1 {
  return createFinalizedChainLoopbackRpcDriverV1(fixture, call =>
    readFinalizedChainAuthorityCallV1(fixture, call));
}

export function readFinalizedChainAuthorityCallV1(
  fixture: FinalizedChainLoopbackFixtureConfigV1,
  { target, data }: FinalizedChainLoopbackContractCallV1,
): string {
  const selector = data.slice(0, 10);
  if (CONTEXT_GRAPH_SELECTORS.has(selector)) {
    assertFinalizedChainCallTargetV1(target, fixture.contextGraphStorageAddress, 'context graph');
  }
  switch (selector) {
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraph')!.selector:
      assertContextGraphCall('getContextGraph', data, fixture.onChainContextGraphId);
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraph', [
        fixture.ownerAddress,
        [],
        0n,
        fixture.active,
        1n,
        fixture.accessPolicy,
        fixture.publishPolicy,
        fixture.publishPolicy === 1 ? ethers.ZeroAddress : fixture.ownerAddress,
        0n,
      ]);
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getNameHash')!.selector:
      assertContextGraphCall('getNameHash', data, fixture.onChainContextGraphId);
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getNameHash', [fixture.nameHash]);
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('isContextGraphActive')!.selector:
      assertContextGraphCall('isContextGraphActive', data, fixture.onChainContextGraphId);
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult(
        'isContextGraphActive',
        [fixture.active],
      );
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaCount')!.selector:
      assertContextGraphCall('getContextGraphKaCount', data, fixture.onChainContextGraphId);
      return FINALIZED_CONTEXT_GRAPH_INTERFACE.encodeFunctionResult('getContextGraphKaCount', [0n]);
    case FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction('getContextGraphKaAt')!.selector: {
      const [id, ordinal] = FINALIZED_CONTEXT_GRAPH_INTERFACE.decodeFunctionData('getContextGraphKaAt', data);
      assertFinalizedChainNumericIdV1(id, fixture.onChainContextGraphId, 'context graph');
      throw new Error(`empty finalized chain inventory has no ordinal ${ordinal}`);
    }
    default: throw new Error(`unexpected finalized chain eth_call selector ${selector}`);
  }
}

const CONTEXT_GRAPH_SELECTORS = new Set([
  'getContextGraph', 'getNameHash', 'isContextGraphActive',
  'getContextGraphKaCount', 'getContextGraphKaAt',
].map(method => FINALIZED_CONTEXT_GRAPH_INTERFACE.getFunction(method)!.selector));

export function assertFinalizedChainCallTargetV1(actual: string, expected: EvmAddressV1, label: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `unexpected finalized chain ${label} target ${actual}; expected ${expected.toLowerCase()}`,
    );
  }
}

function assertContextGraphCall(
  method: string,
  data: string,
  expectedId: string,
): void {
  const [contextGraphId] = FINALIZED_CONTEXT_GRAPH_INTERFACE.decodeFunctionData(method, data);
  assertFinalizedChainNumericIdV1(contextGraphId, expectedId, 'context graph');
}

export function assertFinalizedChainNumericIdV1(actual: unknown, expected: string, label: string): void {
  if (String(actual) !== expected) {
    throw new Error(`unexpected finalized chain ${label} id ${String(actual)}`);
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}
