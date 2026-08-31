import { decode, encode } from 'cborg';

export const ABI_VERSION = 1;
export const SCHEMA_VERSION = 1;

export const MESSAGE_TYPE = {
  create: 1,
  apply: 2,
  snapshot: 3,
  restore: 4,
  inspect: 5,
  drop: 6,
  compile: 7,
  admit: 8,
  startPlan: 9,
  inspectPlan: 10,
  dropPlan: 11,
  applyPlan: 12,
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export interface Phase0RuntimeConfig {
  partitionId: Uint8Array;
  maxEvents: number;
  maxAccumulator: bigint;
}

export type Phase0RuntimeEvent =
  | {
      kind: 'advance';
      eventId: Uint8Array;
      logicalTime: bigint;
      delta: bigint;
    }
  | {
      kind: 'set-deadline';
      eventId: Uint8Array;
      logicalTime: bigint;
      deadline: bigint | null;
    };

export interface Phase0TraceEvent {
  eventId: Uint8Array;
  logicalTime: bigint;
  kind: 'accumulator-advanced' | 'deadline-changed' | 'duplicate-ignored';
  value: bigint;
}

export interface Phase0StepOutput {
  appliedEvents: number;
  accumulator: bigint;
  nextDeadline: bigint | null;
  stateDigest: Uint8Array;
  traceEvents: Phase0TraceEvent[];
  yielded: boolean;
  encoded: Uint8Array;
}

export interface Phase0Inspection {
  appliedEvents: number;
  accumulator: bigint;
  lastLogicalTime: bigint;
  nextDeadline: bigint | null;
  stateDigest: Uint8Array;
}

export interface AdmissionDiagnostic {
  code: string;
  primary: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  message: string;
  help: string | null;
}

export interface AdmittedPlanSummary {
  canonicalPlan: Uint8Array;
  canonicalHash: Uint8Array;
  strategyRef: string;
  scope: string;
  goal: string;
  requiredCapabilities: string[];
  effectUpperBound: string[];
  approvalRequirements: string[];
  adapterVersions: Map<string, number>;
  resourceBounds: {
    processes: number;
    hostCommands: number;
    retryAttempts: number;
    depth: number;
  };
}

export type CompileStrategyResult =
  | { ok: true; plan: AdmittedPlanSummary }
  | { ok: false; diagnostics: AdmissionDiagnostic[] };

export interface StartedLogicalAgent {
  role: string;
  processId: Uint8Array;
  status: 'runnable' | 'waiting' | 'cancelling' | 'terminated' | 'missing';
}

export interface StartedPlanInspection {
  canonicalHash: Uint8Array;
  strategyRef: string;
  logicalTime: bigint;
  stateDigest: Uint8Array;
  agents: StartedLogicalAgent[];
}

export interface StartedPlanReceipt extends StartedPlanInspection {
  handle: number;
}

export interface PlanValue {
  role: string;
  processId: Uint8Array;
  value: string;
}

export type PlanApplyResult =
  | {
      kind: 'effect-requested';
      effectId: bigint;
      processId: Uint8Array;
      operation: string;
      version: number;
      arguments: string[];
    }
  | { kind: 'completed'; events: PlanValue[]; outputs: PlanValue[] };

export class AbiResponseError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: string,
    public readonly retryable: boolean,
  ) {
    super(`semantic runtime ABI error ${code} (${category})`);
    this.name = 'AbiResponseError';
  }
}

export function encodeCreateRequest(requestId: bigint, config: Phase0RuntimeConfig): Uint8Array {
  assertId(config.partitionId, 'partitionId');
  if (!Number.isInteger(config.maxEvents) || config.maxEvents <= 0 || config.maxEvents > 100_000) {
    throw new RangeError('maxEvents must be an integer from 1 through 100000');
  }
  if (config.maxAccumulator <= 0n || config.maxAccumulator > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('maxAccumulator must fit an unsigned 64-bit integer');
  }
  return encodeEnvelope(requestId, MESSAGE_TYPE.create, [
    config.partitionId,
    config.maxEvents,
    config.maxAccumulator,
  ]);
}

export function encodeEventRequest(requestId: bigint, event: Phase0RuntimeEvent): Uint8Array {
  assertId(event.eventId, 'eventId');
  assertU64(event.logicalTime, 'logicalTime');
  if (event.kind === 'advance') {
    assertU64(event.delta, 'delta');
    return encodeEnvelope(requestId, MESSAGE_TYPE.apply, [
      0,
      event.eventId,
      event.logicalTime,
      event.delta,
    ]);
  }
  if (event.deadline !== null) assertU64(event.deadline, 'deadline');
  return encodeEnvelope(requestId, MESSAGE_TYPE.apply, [
    1,
    event.eventId,
    event.logicalTime,
    event.deadline,
  ]);
}

export function encodeCompileRequest(requestId: bigint, source: string): Uint8Array {
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > 1024 * 1024) throw new RangeError('strategy source exceeds 1 MiB');
  return encodeEnvelope(requestId, MESSAGE_TYPE.compile, bytes, true);
}

export function encodeAdmitRequest(requestId: bigint, canonicalPlan: Uint8Array): Uint8Array {
  if (!(canonicalPlan instanceof Uint8Array) || canonicalPlan.byteLength > 4 * 1024 * 1024) {
    throw new RangeError('canonical plan must be bytes no larger than 4 MiB');
  }
  return encodeEnvelope(requestId, MESSAGE_TYPE.admit, canonicalPlan, true);
}

export function encodeStartPlanRequest(
  requestId: bigint,
  canonicalPlan: Uint8Array,
  logicalTime: bigint,
): Uint8Array {
  if (!(canonicalPlan instanceof Uint8Array) || canonicalPlan.byteLength > 4 * 1024 * 1024) {
    throw new RangeError('canonical plan must be bytes no larger than 4 MiB');
  }
  assertU64(logicalTime, 'logicalTime');
  return encodeEnvelope(requestId, MESSAGE_TYPE.startPlan, [canonicalPlan, logicalTime]);
}

export function encodeApplyPlanRequest(
  requestId: bigint,
  result?: { effectId: bigint; ok: boolean; value: string },
): Uint8Array {
  return encodeEnvelope(
    requestId,
    MESSAGE_TYPE.applyPlan,
    result ? [1, result.effectId, result.ok, result.value] : [0],
  );
}

export function encodeEmptyRequest(requestId: bigint, messageType: MessageType): Uint8Array {
  return encodeEnvelope(requestId, messageType, []);
}

export function encodeRestoreRequest(requestId: bigint, snapshot: Uint8Array): Uint8Array {
  return encodeEnvelope(requestId, MESSAGE_TYPE.restore, snapshot, true);
}

export function decodeAbiSuccess(
  input: Uint8Array,
  expectedRequestId: bigint,
  expectedMessageType: MessageType,
): Uint8Array {
  const envelope = expectArray(decode(input), 5, 'ABI envelope');
  if (
    toNumber(envelope[0], 'abiVersion') !== ABI_VERSION
    || toNumber(envelope[1], 'schemaVersion') !== SCHEMA_VERSION
  ) {
    throw new Error('semantic runtime returned an incompatible ABI envelope');
  }
  if (toBigInt(envelope[2], 'requestId') !== expectedRequestId) {
    throw new Error('semantic runtime returned a mismatched ABI requestId');
  }
  if (toNumber(envelope[3], 'messageType') !== expectedMessageType) {
    throw new Error('semantic runtime returned a mismatched ABI messageType');
  }
  const resultBytes = expectBytes(envelope[4], 'ABI result bytes');
  const result = expectArray(decode(resultBytes), undefined, 'ABI result');
  const tag = toNumber(result[0], 'result tag');
  if (tag === 1) {
    if (result.length !== 4) throw new Error('semantic runtime returned a malformed ABI error');
    throw new AbiResponseError(
      expectString(result[1], 'error code'),
      expectString(result[2], 'error category'),
      expectBoolean(result[3], 'error retryability'),
    );
  }
  if (tag !== 0 || result.length !== 2) {
    throw new Error('semantic runtime returned a malformed ABI success');
  }
  return Uint8Array.from(expectBytes(result[1], 'ABI success payload'));
}

export function decodeHandle(payload: Uint8Array): number {
  const value = expectArray(decode(payload), 1, 'handle payload');
  const handle = toNumber(value[0], 'runtime handle');
  if (!Number.isInteger(handle) || handle <= 0 || handle > 0xffff_ffff) {
    throw new Error('semantic runtime returned an invalid handle');
  }
  return handle;
}

export function decodeStatus(payload: Uint8Array): boolean {
  return expectBoolean(expectArray(decode(payload), 1, 'status payload')[0], 'status');
}

export function decodeStepOutput(payload: Uint8Array): Phase0StepOutput {
  const value = expectArray(decode(payload), 6, 'step output');
  const traces = expectArray(value[4], undefined, 'trace events').map((raw) => {
    const trace = expectArray(raw, 4, 'trace event');
    const kind = toNumber(trace[2], 'trace kind');
    const names = ['accumulator-advanced', 'deadline-changed', 'duplicate-ignored'] as const;
    if (kind < 0 || kind >= names.length) throw new Error('unknown trace kind');
    const eventId = Uint8Array.from(expectBytes(trace[0], 'trace eventId'));
    assertId(eventId, 'trace eventId');
    return {
      eventId,
      logicalTime: toBigInt(trace[1], 'trace logicalTime'),
      kind: names[kind],
      value: toBigInt(trace[3], 'trace value'),
    };
  });
  const stateDigest = Uint8Array.from(expectBytes(value[3], 'state digest'));
  assertId(stateDigest, 'state digest');
  return {
    appliedEvents: toNumber(value[0], 'appliedEvents'),
    accumulator: toBigInt(value[1], 'accumulator'),
    nextDeadline: nullableBigInt(value[2], 'nextDeadline'),
    stateDigest,
    traceEvents: traces,
    yielded: expectBoolean(value[5], 'yielded'),
    encoded: Uint8Array.from(payload),
  };
}

export function decodeInspection(payload: Uint8Array): Phase0Inspection {
  const value = expectArray(decode(payload), 5, 'inspection');
  const stateDigest = Uint8Array.from(expectBytes(value[4], 'state digest'));
  assertId(stateDigest, 'state digest');
  return {
    appliedEvents: toNumber(value[0], 'appliedEvents'),
    accumulator: toBigInt(value[1], 'accumulator'),
    lastLogicalTime: toBigInt(value[2], 'lastLogicalTime'),
    nextDeadline: nullableBigInt(value[3], 'nextDeadline'),
    stateDigest,
  };
}

export function decodeCompileResult(payload: Uint8Array): CompileStrategyResult {
  const outcome = expectArray(decode(payload), 2, 'compile outcome');
  const tag = toNumber(outcome[0], 'compile outcome tag');
  const body = Uint8Array.from(expectBytes(outcome[1], 'compile outcome body'));
  if (tag === 0) return { ok: true, plan: decodeAdmittedPlan(body) };
  if (tag !== 1) throw new Error('semantic runtime returned an unknown compile outcome');
  return { ok: false, diagnostics: decodeAdmissionDiagnostics(body) };
}

export function decodeAdmittedPlan(payload: Uint8Array): AdmittedPlanSummary {
  const value = expectArray(decode(payload), 10, 'admitted plan summary');
  const canonicalPlan = Uint8Array.from(expectBytes(value[0], 'canonical plan'));
  const canonicalHash = Uint8Array.from(expectBytes(value[1], 'canonical hash'));
  assertId(canonicalHash, 'canonical hash');
  const requiredCapabilities = stringArray(value[5], 'required capabilities');
  const effectUpperBound = stringArray(value[6], 'effect upper bound');
  const approvalRequirements = stringArray(value[7], 'approval requirements');
  const adapterVersions = numberMap(value[8], 'adapter versions');
  const bounds = expectArray(value[9], 4, 'resource bounds');
  return {
    canonicalPlan,
    canonicalHash,
    strategyRef: expectString(value[2], 'strategy reference'),
    scope: expectString(value[3], 'strategy scope'),
    goal: expectString(value[4], 'strategy goal'),
    requiredCapabilities,
    effectUpperBound,
    approvalRequirements,
    adapterVersions,
    resourceBounds: {
      processes: toNumber(bounds[0], 'process bound'),
      hostCommands: toNumber(bounds[1], 'host-command bound'),
      retryAttempts: toNumber(bounds[2], 'retry bound'),
      depth: toNumber(bounds[3], 'plan depth'),
    },
  };
}

export function decodeStartedPlanReceipt(payload: Uint8Array): StartedPlanReceipt {
  const value = expectArray(decode(payload), 6, 'started plan receipt');
  const handle = toNumber(value[0], 'started plan handle');
  if (!Number.isInteger(handle) || handle <= 0 || handle > 0xffff_ffff) {
    throw new Error('semantic runtime returned an invalid plan handle');
  }
  return { handle, ...decodeStartedPlanFields(value.slice(1)) };
}

export function decodeStartedPlanInspection(payload: Uint8Array): StartedPlanInspection {
  return decodeStartedPlanFields(expectArray(decode(payload), 5, 'started plan inspection'));
}

export function decodePlanApplyResult(payload: Uint8Array): PlanApplyResult {
  const value = expectArray(decode(payload), undefined, 'plan apply result');
  const kind = toNumber(value[0], 'plan apply result kind');
  if (kind === 0 && value.length === 6) {
    const processId = Uint8Array.from(expectBytes(value[2], 'effect processId'));
    assertId(processId, 'effect processId');
    return {
      kind: 'effect-requested',
      effectId: toBigInt(value[1], 'effectId'),
      processId,
      operation: expectString(value[3], 'effect operation'),
      version: toNumber(value[4], 'effect version'),
      arguments: stringArray(value[5], 'effect arguments'),
    };
  }
  if (kind !== 1 || value.length !== 3) throw new Error('unknown plan apply result');
  const decodeValues = (raw: unknown, label: string): PlanValue[] =>
    expectArray(raw, undefined, label).map((entry) => {
      const item = expectArray(entry, 3, label);
      const processId = Uint8Array.from(expectBytes(item[1], `${label} processId`));
      assertId(processId, `${label} processId`);
      return {
        role: expectString(item[0], `${label} role`),
        processId,
        value: expectString(item[2], `${label} value`),
      };
    });
  return {
    kind: 'completed',
    events: decodeValues(value[1], 'plan event'),
    outputs: decodeValues(value[2], 'plan output'),
  };
}

function decodeStartedPlanFields(value: unknown[]): StartedPlanInspection {
  const canonicalHash = Uint8Array.from(expectBytes(value[0], 'started plan canonical hash'));
  const stateDigest = Uint8Array.from(expectBytes(value[3], 'started plan state digest'));
  assertId(canonicalHash, 'started plan canonical hash');
  assertId(stateDigest, 'started plan state digest');
  const validStatuses = new Set<StartedLogicalAgent['status']>([
    'runnable',
    'waiting',
    'cancelling',
    'terminated',
    'missing',
  ]);
  const agents = expectArray(value[4], undefined, 'started logical agents').map((raw) => {
    const agent = expectArray(raw, 3, 'started logical agent');
    const processId = Uint8Array.from(expectBytes(agent[1], 'logical agent processId'));
    assertId(processId, 'logical agent processId');
    const status = expectString(agent[2], 'logical agent status') as StartedLogicalAgent['status'];
    if (!validStatuses.has(status)) throw new Error(`unknown logical agent status: ${status}`);
    return {
      role: expectString(agent[0], 'logical agent role'),
      processId,
      status,
    };
  });
  return {
    canonicalHash,
    strategyRef: expectString(value[1], 'started plan strategy reference'),
    logicalTime: toBigInt(value[2], 'started plan logical time'),
    stateDigest,
    agents,
  };
}

function decodeAdmissionDiagnostics(payload: Uint8Array): AdmissionDiagnostic[] {
  return expectArray(decode(payload), undefined, 'admission diagnostics').map((entry) => {
    const value = expectArray(entry, 7, 'admission diagnostic');
    return {
      code: expectString(value[0], 'diagnostic code'),
      primary: {
        start: {
          line: toNumber(value[1], 'diagnostic start line'),
          column: toNumber(value[2], 'diagnostic start column'),
        },
        end: {
          line: toNumber(value[3], 'diagnostic end line'),
          column: toNumber(value[4], 'diagnostic end column'),
        },
      },
      message: expectString(value[5], 'diagnostic message'),
      help: value[6] === null ? null : expectString(value[6], 'diagnostic help'),
    };
  });
}

function encodeEnvelope(
  requestId: bigint,
  messageType: MessageType,
  payload: unknown,
  payloadIsEncoded = false,
): Uint8Array {
  assertU64(requestId, 'requestId');
  const encodedPayload = payloadIsEncoded
    ? Uint8Array.from(expectBytes(payload, 'encoded payload'))
    : encode(payload);
  return encode([ABI_VERSION, SCHEMA_VERSION, requestId, messageType, encodedPayload]);
}

function expectArray(value: unknown, length: number | undefined, label: string): unknown[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    throw new TypeError(`${label} must be an array${length === undefined ? '' : ` of length ${length}`}`);
  }
  return value;
}

function expectBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${label} must be an unsigned integer`);
}

function toNumber(value: unknown, label: string): number {
  const bigint = toBigInt(value, label);
  if (bigint > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds safe integer range`);
  return Number(bigint);
}

function nullableBigInt(value: unknown, label: string): bigint | null {
  return value === null ? null : toBigInt(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  return expectArray(value, undefined, label).map((entry) => expectString(entry, label));
}

function numberMap(value: unknown, label: string): Map<string, number> {
  const result = new Map<string, number>();
  const entries = value instanceof Map
    ? [...value.entries()]
    : typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : null;
  if (!entries) throw new TypeError(`${label} must be a map`);
  for (const [key, entry] of entries) {
    result.set(expectString(key, `${label} key`), toNumber(entry, `${label} value`));
  }
  return result;
}

function assertId(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

function assertU64(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must fit an unsigned 64-bit integer`);
  }
}
