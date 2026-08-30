import type {
  ContextGraphReconcileResult,
  ReplicationEvent,
} from '@origintrail-official/dkg-agent';

export type Gate1RolloutMode = 'legacy' | 'shadow' | 'catalog';
export type Gate1VmChainScenario = 'valid' | 'inactive' | 'private' | 'root-count-drift';

export const GATE1_VM_CHAIN_READ_KEYS = Object.freeze([
  'accessPolicy',
  'active',
  'author',
  'count',
  'kaAt',
  'latestRoot',
  'nameHashResolution',
  'publisher',
  'rootCount',
  'storageAddress',
] as const);

export type Gate1VmChainReadKey = typeof GATE1_VM_CHAIN_READ_KEYS[number];
export type Gate1VmChainReadCounts = Readonly<Record<Gate1VmChainReadKey, number>>;

/** Exact evidence projection consumed by the transition certificate. */
export type Gate1ReplicationEvent = Readonly<Pick<
  ReplicationEvent,
  'action' | 'contextGraphId' | 'ordinal'
>>;

export interface Gate1RolloutStatusResult {
  readonly bootstrapStarted: boolean;
  readonly catalogServiceStarted: boolean;
  readonly legacyConfiguredScope: boolean;
  readonly manualLegacySwmTargetCount: number;
  readonly vmChainInventorySelected: boolean;
}

export interface Gate1VmReconcileResult {
  readonly chainReadDelta: Gate1VmChainReadCounts;
  readonly replicationEvents: readonly Gate1ReplicationEvent[];
  readonly result: ContextGraphReconcileResult;
}

export interface Gate1SeedVmSourceSwmResult {
  readonly swmGraph: string;
  readonly tripleCount: number;
}

export interface Gate1AuthorStoreProbeQuad {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export interface Gate1AuthorStoreProbeResult {
  readonly graphUri: string;
  readonly tripleCount: number;
}

export interface Gate1RolloutCommandMap {
  readonly writeAuthorStoreProbe: {
    readonly input: {
      readonly graphUri: string;
      readonly quads: readonly Gate1AuthorStoreProbeQuad[];
    };
    readonly output: Gate1AuthorStoreProbeResult;
  };
  readonly rolloutStatus: {
    readonly input: {
      readonly contextGraphId: string;
      readonly completeProviderPeerId: string;
    };
    readonly output: Gate1RolloutStatusResult;
  };
  readonly vmReconcile: {
    readonly input: { readonly contextGraphId: string };
    readonly output: Gate1VmReconcileResult;
  };
  readonly seedVmSourceSwm: {
    readonly input: { readonly contextGraphId: string };
    readonly output: Gate1SeedVmSourceSwmResult;
  };
  readonly stagedHeadReadback: {
    readonly input: {
      readonly objectDigest: string;
      readonly signatureVariantDigest: string;
    };
    readonly output: string | null;
  };
}

export type Gate1RolloutCommand = keyof Gate1RolloutCommandMap;
export type Gate1RolloutCommandInput<K extends Gate1RolloutCommand> =
  Gate1RolloutCommandMap[K]['input'];
export type Gate1RolloutCommandOutput<K extends Gate1RolloutCommand> =
  Gate1RolloutCommandMap[K]['output'];

type Gate1RolloutCommandDefinitionMap = {
  readonly [K in Gate1RolloutCommand]: Readonly<{
    role: 'author' | 'receiver';
    parseInput(value: unknown): Gate1RolloutCommandInput<K>;
    parseOutput(value: unknown): Gate1RolloutCommandOutput<K>;
  }>;
};

const GATE1_ROLLOUT_COMMAND_DEFINITIONS: Gate1RolloutCommandDefinitionMap =
  Object.freeze({
    writeAuthorStoreProbe: Object.freeze({
      role: 'author',
      parseInput: parseAuthorStoreProbeInput,
      parseOutput: parseAuthorStoreProbeOutput,
    }),
    rolloutStatus: Object.freeze({
      role: 'receiver',
      parseInput: parseRolloutStatusInput,
      parseOutput: parseRolloutStatusOutput,
    }),
    vmReconcile: Object.freeze({
      role: 'receiver',
      parseInput: parseContextGraphInput,
      parseOutput: parseVmReconcileOutput,
    }),
    seedVmSourceSwm: Object.freeze({
      role: 'receiver',
      parseInput: parseContextGraphInput,
      parseOutput: parseSeedVmSourceSwmOutput,
    }),
    stagedHeadReadback: Object.freeze({
      role: 'receiver',
      parseInput: parseStagedHeadReadbackInput,
      parseOutput: parseStagedHeadReadbackOutput,
    }),
  });

export const GATE1_ROLLOUT_COMMANDS = Object.freeze(
  Object.keys(GATE1_ROLLOUT_COMMAND_DEFINITIONS) as Gate1RolloutCommand[],
);

export function isGate1RolloutCommand(value: string): value is Gate1RolloutCommand {
  return Object.hasOwn(GATE1_ROLLOUT_COMMAND_DEFINITIONS, value);
}

export function gate1RolloutCommandRole(
  command: Gate1RolloutCommand,
): 'author' | 'receiver' {
  return GATE1_ROLLOUT_COMMAND_DEFINITIONS[command].role;
}

/** Parse the JSON process boundary once; client and adapter share this registry. */
export function parseGate1RolloutCommandInput<K extends Gate1RolloutCommand>(
  command: K,
  value: unknown,
): Gate1RolloutCommandInput<K> {
  return GATE1_ROLLOUT_COMMAND_DEFINITIONS[command].parseInput(value);
}

export function parseGate1RolloutCommandOutput<K extends Gate1RolloutCommand>(
  command: K,
  value: unknown,
): Gate1RolloutCommandOutput<K> {
  return GATE1_ROLLOUT_COMMAND_DEFINITIONS[command].parseOutput(value);
}

function parseAuthorStoreProbeInput(
  value: unknown,
): Gate1RolloutCommandInput<'writeAuthorStoreProbe'> {
  const input = plainRecord(value, 'writeAuthorStoreProbe input');
  if (!Array.isArray(input.quads) || input.quads.length === 0 || input.quads.length > 10_000) {
    throw new TypeError('writeAuthorStoreProbe.quads must be a bounded non-empty array');
  }
  return Object.freeze({
    graphUri: requiredString(input.graphUri, 'writeAuthorStoreProbe.graphUri'),
    quads: Object.freeze(input.quads.map((value, index) => {
      const quad = plainRecord(value, `writeAuthorStoreProbe.quads[${index}]`);
      return Object.freeze({
        subject: requiredString(quad.subject, `writeAuthorStoreProbe.quads[${index}].subject`),
        predicate: requiredString(
          quad.predicate,
          `writeAuthorStoreProbe.quads[${index}].predicate`,
        ),
        object: requiredString(quad.object, `writeAuthorStoreProbe.quads[${index}].object`),
      });
    })),
  });
}

function parseAuthorStoreProbeOutput(
  value: unknown,
): Gate1RolloutCommandOutput<'writeAuthorStoreProbe'> {
  const output = plainRecord(value, 'writeAuthorStoreProbe output');
  return Object.freeze({
    graphUri: requiredString(output.graphUri, 'writeAuthorStoreProbe.graphUri'),
    tripleCount: requiredNonNegativeInteger(
      output.tripleCount,
      'writeAuthorStoreProbe.tripleCount',
    ),
  });
}

function parseRolloutStatusInput(
  value: unknown,
): Gate1RolloutCommandInput<'rolloutStatus'> {
  const input = plainRecord(value, 'rolloutStatus input');
  return Object.freeze({
    contextGraphId: requiredString(input.contextGraphId, 'rolloutStatus.contextGraphId'),
    completeProviderPeerId: requiredString(
      input.completeProviderPeerId,
      'rolloutStatus.completeProviderPeerId',
    ),
  });
}

function parseContextGraphInput(
  value: unknown,
): Gate1RolloutCommandInput<'vmReconcile' | 'seedVmSourceSwm'> {
  const input = plainRecord(value, 'context-graph rollout input');
  return Object.freeze({
    contextGraphId: requiredString(input.contextGraphId, 'rollout contextGraphId'),
  });
}

function parseStagedHeadReadbackInput(
  value: unknown,
): Gate1RolloutCommandInput<'stagedHeadReadback'> {
  const input = plainRecord(value, 'stagedHeadReadback input');
  return Object.freeze({
    objectDigest: requiredDigest(input.objectDigest, 'stagedHeadReadback.objectDigest'),
    signatureVariantDigest: requiredDigest(
      input.signatureVariantDigest,
      'stagedHeadReadback.signatureVariantDigest',
    ),
  });
}

function parseStagedHeadReadbackOutput(
  value: unknown,
): Gate1RolloutCommandOutput<'stagedHeadReadback'> {
  return value === null
    ? null
    : requiredDigest(value, 'stagedHeadReadback output');
}

function parseRolloutStatusOutput(
  value: unknown,
): Gate1RolloutCommandOutput<'rolloutStatus'> {
  const output = plainRecord(value, 'rolloutStatus output');
  return Object.freeze({
    bootstrapStarted: requiredBoolean(output.bootstrapStarted, 'rolloutStatus.bootstrapStarted'),
    catalogServiceStarted: requiredBoolean(
      output.catalogServiceStarted,
      'rolloutStatus.catalogServiceStarted',
    ),
    legacyConfiguredScope: requiredBoolean(
      output.legacyConfiguredScope,
      'rolloutStatus.legacyConfiguredScope',
    ),
    manualLegacySwmTargetCount: requiredNonNegativeInteger(
      output.manualLegacySwmTargetCount,
      'rolloutStatus.manualLegacySwmTargetCount',
    ),
    vmChainInventorySelected: requiredBoolean(
      output.vmChainInventorySelected,
      'rolloutStatus.vmChainInventorySelected',
    ),
  });
}

function parseSeedVmSourceSwmOutput(
  value: unknown,
): Gate1RolloutCommandOutput<'seedVmSourceSwm'> {
  const output = plainRecord(value, 'seedVmSourceSwm output');
  return Object.freeze({
    swmGraph: requiredString(output.swmGraph, 'seedVmSourceSwm.swmGraph'),
    tripleCount: requiredNonNegativeInteger(
      output.tripleCount,
      'seedVmSourceSwm.tripleCount',
    ),
  });
}

function parseVmReconcileOutput(
  value: unknown,
): Gate1RolloutCommandOutput<'vmReconcile'> {
  const output = plainRecord(value, 'vmReconcile output');
  const reads = plainRecord(output.chainReadDelta, 'vmReconcile.chainReadDelta');
  const chainReadDelta = Object.freeze(Object.fromEntries(
    GATE1_VM_CHAIN_READ_KEYS.map((key) => [
      key,
      requiredNonNegativeInteger(reads[key], `vmReconcile.chainReadDelta.${key}`),
    ]),
  )) as Gate1VmChainReadCounts;
  const events = output.replicationEvents;
  if (!Array.isArray(events)) throw new TypeError('vmReconcile.replicationEvents must be an array');
  const replicationEvents = Object.freeze(events.map(parseReplicationEvent));
  const result = parseContextGraphReconcileResult(output.result);
  return Object.freeze({ chainReadDelta, replicationEvents, result });
}

function parseContextGraphReconcileResult(value: unknown): ContextGraphReconcileResult {
  const result = plainRecord(value, 'vmReconcile.result');
  const source = requiredString(result.source, 'vmReconcile.result.source');
  const status = requiredString(result.status, 'vmReconcile.result.status');
  if (!['live', 'manual', 'periodic'].includes(source)) {
    throw new TypeError('vmReconcile.result.source is invalid');
  }
  if (!['current', 'progress', 'pending', 'watermark-ahead'].includes(status)) {
    throw new TypeError('vmReconcile.result.status is invalid');
  }
  return Object.freeze({
    contextGraphId: requiredString(result.contextGraphId, 'vmReconcile.result.contextGraphId'),
    onChainId: requiredString(result.onChainId, 'vmReconcile.result.onChainId'),
    source: source as ContextGraphReconcileResult['source'],
    status: status as ContextGraphReconcileResult['status'],
    attempted: requiredBoolean(result.attempted, 'vmReconcile.result.attempted'),
    headOrdinal: requiredNonNegativeInteger(result.headOrdinal, 'vmReconcile.result.headOrdinal'),
    watermarkBefore: requiredNonNegativeInteger(
      result.watermarkBefore,
      'vmReconcile.result.watermarkBefore',
    ),
    watermarkAfter: requiredNonNegativeInteger(
      result.watermarkAfter,
      'vmReconcile.result.watermarkAfter',
    ),
    reconciledOrdinals: requiredNonNegativeInteger(
      result.reconciledOrdinals,
      'vmReconcile.result.reconciledOrdinals',
    ),
    unresolvedOrdinals: requiredNonNegativeInteger(
      result.unresolvedOrdinals,
      'vmReconcile.result.unresolvedOrdinals',
    ),
  });
}

function parseReplicationEvent(value: unknown): Gate1ReplicationEvent {
  const event = plainRecord(value, 'vmReconcile replication event');
  const action = requiredString(event.action, 'vmReconcile replication event action');
  if (!['sweep', 'fetch', 'promote', 'already', 'defer', 'cursor-advance', 'core-fill']
    .includes(action)) {
    throw new TypeError('vmReconcile replication event action is invalid');
  }
  return Object.freeze({
    contextGraphId: requiredString(
      event.contextGraphId,
      'vmReconcile replication event contextGraphId',
    ),
    action: action as Gate1ReplicationEvent['action'],
    ...optionalNonNegativeIntegerField(event, 'ordinal'),
  });
}

function optionalNonNegativeIntegerField<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Readonly<Record<string, number>> {
  const value = record[key];
  return value === undefined
    ? {}
    : { [key]: requiredNonNegativeInteger(value, `replication event ${key}`) };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError(`${label} must be a lowercase 32-byte digest`);
  }
  return digest;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}
