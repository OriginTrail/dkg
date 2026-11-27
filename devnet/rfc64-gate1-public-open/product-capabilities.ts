import {
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  type Gate1ProductionAdapterOperation,
} from './model.js';

export const PRODUCT_METHOD_BY_OPERATION = Object.freeze({
  publishGenesis: 'publishOpenAuthorCatalogGenesisV1',
  publishSuccessor: 'publishOpenAuthorCatalogSuccessorV1',
  announce: 'announceRfc64PublicCatalogHeadV1',
  appliedHeadReadback: 'readRfc64AppliedCatalogHeadV1',
  exactInventoryReadback: 'readRfc64PublicCatalogSynchronizationEvidenceV1',
  // SIGKILL and process replacement are deliberately owned by the harness.
  killRestart: null,
} satisfies Record<Gate1ProductionAdapterOperation, string | null>);

export type Gate1ProductCapabilities = Readonly<
  Record<Gate1ProductionAdapterOperation, boolean>
>;

export function inspectGate1ProductCapabilities(agent: object): Gate1ProductCapabilities {
  const surface = agent as Record<string, unknown>;
  return Object.freeze(Object.fromEntries(
    REQUIRED_PRODUCTION_ADAPTER_OPERATIONS.map((operation) => {
      const method = PRODUCT_METHOD_BY_OPERATION[operation];
      return [operation, method === null || typeof surface[method] === 'function'];
    }),
  ) as unknown as Gate1ProductCapabilities);
}

export function assertGate1ProductCapabilities(input: {
  readonly author: unknown;
  readonly receiver: unknown;
}): void {
  const author = exactCapabilityRecord(input.author, 'author');
  const receiver = exactCapabilityRecord(input.receiver, 'receiver');
  const requiredByRole = {
    author: ['publishGenesis', 'publishSuccessor', 'announce'],
    receiver: ['appliedHeadReadback', 'exactInventoryReadback', 'killRestart'],
  } as const satisfies Record<'author' | 'receiver', readonly Gate1ProductionAdapterOperation[]>;
  const missing: string[] = [];
  for (const [role, required] of Object.entries(requiredByRole) as Array<
    readonly ['author' | 'receiver', readonly Gate1ProductionAdapterOperation[]]
  >) {
    const capabilities = role === 'author' ? author : receiver;
    for (const operation of required) {
      if (capabilities[operation]) continue;
      const method = PRODUCT_METHOD_BY_OPERATION[operation];
      missing.push(`${role}.${operation}${method === null ? '' : ` (${method})`}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'RFC-64 Gate 1 production DKGAgent API is incomplete; missing '
        + `${missing.join(', ')}. The harness will not fabricate product evidence.`,
    );
  }
}

function exactCapabilityRecord(value: unknown, label: string): Gate1ProductCapabilities {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} Gate 1 capabilities must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...REQUIRED_PRODUCTION_ADAPTER_OPERATIONS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} Gate 1 capabilities do not match the frozen operation set`);
  }
  for (const operation of REQUIRED_PRODUCTION_ADAPTER_OPERATIONS) {
    if (typeof record[operation] !== 'boolean') {
      throw new TypeError(`${label}.${operation} capability must be boolean`);
    }
  }
  return record as unknown as Gate1ProductCapabilities;
}

export function requireGate1ProductMethod(
  agent: object,
  operation: Exclude<Gate1ProductionAdapterOperation, 'killRestart'>,
): (input: unknown) => Promise<unknown> {
  const methodName = PRODUCT_METHOD_BY_OPERATION[operation];
  if (methodName === null) throw new Error(`${operation} is harness-owned`);
  const method = (agent as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') {
    throw new Error(
      `RFC-64 Gate 1 operation ${operation} requires DKGAgent.${methodName}; `
        + 'the harness will not fabricate its result',
    );
  }
  return method.bind(agent) as (input: unknown) => Promise<unknown>;
}
