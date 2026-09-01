import { createHash } from 'node:crypto';

import { decode, encode } from 'cborg';

import {
  type CapabilityRecord,
  type DurableIdempotencyClass,
  type EffectRecord,
  SemanticRuntimeStore,
} from './persistence.js';
import type { AdmittedPlanSummary } from './codec.js';

export interface RuntimeCapabilityMetadata {
  subject: string;
  audience: string;
  executionId: string;
  verbs: string[];
  resources: string[];
  delegationDepth: number;
  oneShot: boolean;
  budgetMicros: bigint;
  parentCapabilityId?: string;
}

export interface RuntimePolicyInput {
  executionId: string;
  principal: string;
  capabilityId: string;
  adapterId: string;
  adapterVersion: string;
  verb: string;
  resource: string;
  requestDigest: Uint8Array;
  policyEpoch: bigint;
}

export interface RuntimePolicyDecision {
  decision: 'allow' | 'deny';
  policyId: string;
  policyEpoch: bigint;
  factsDigest: Uint8Array;
  reasonCode: string;
}

export interface RuntimePolicyAdapter {
  evaluate(input: RuntimePolicyInput): Promise<RuntimePolicyDecision>;
}

export interface ReconciliationResult {
  status: 'applied' | 'not_applied' | 'unknown';
  evidenceRef: string;
  output?: unknown;
}

interface PreparedEffectToken {
  readonly effectId: string;
  readonly attemptId: string;
  readonly requestDigest: Uint8Array;
  readonly capabilityId: string;
  readonly policyDecisionId: string;
}

export interface RuntimeAdapterOperation<I = unknown, O = unknown> {
  readonly id: string;
  readonly version: string;
  /** Component Model interface identity bound to the explicit host import. */
  readonly witInterface?: string;
  /** Version and digest of the locally installed host implementation. */
  readonly implementationVersion?: string;
  readonly implementationHash?: string;
  readonly enabled?: () => boolean;
  readonly effectClass: string;
  readonly verb: string;
  readonly idempotencyClass: DurableIdempotencyClass;
  readonly reconciliationRule: string;
  readonly compensationRule?: string;
  validateInput(input: unknown): I;
  dispatch(authorization: Readonly<PreparedEffectToken>, input: I): Promise<{
    status: 'succeeded' | 'failed';
    output: O;
    evidenceRef: string;
  }>;
  reconcile(
    effect: Readonly<EffectRecord>,
    input: I,
  ): Promise<ReconciliationResult>;
  couldHaveReachedTarget(error: unknown): boolean;
}

export interface RuntimeAdapterDescriptor {
  id: string;
  version: string;
  witInterface: string | null;
  implementationVersion: string | null;
  implementationHash: string | null;
  enabled: boolean;
  effectClass: string;
  verb: string;
}

const REGISTERED_ADAPTERS = new WeakMap<RuntimeAdapterRegistry, Map<string, RuntimeAdapterOperation>>();

export class RuntimeAdapterRegistry {
  constructor() {
    REGISTERED_ADAPTERS.set(this, new Map());
  }

  register<I, O>(operation: RuntimeAdapterOperation<I, O>): void {
    const version = Number(operation.version);
    if (
      !operation.id
      || !/^[1-9]\d*$/.test(operation.version)
      || !Number.isInteger(version)
      || version > 0xffff
    ) {
      throw new Error('adapter registration requires a stable id and exact positive V1 version');
    }
    const key = adapterKey(operation.id, operation.version);
    const operations = requireRegistry(this);
    if (operations.has(key)) throw new Error(`adapter already registered: ${key}`);
    operations.set(key, operation as RuntimeAdapterOperation);
  }

  describe(id: string, version: string): RuntimeAdapterDescriptor | null {
    const operation = requireRegistry(this).get(adapterKey(id, version));
    if (!operation) return null;
    return {
      id: operation.id,
      version: operation.version,
      witInterface: operation.witInterface ?? null,
      implementationVersion: operation.implementationVersion ?? null,
      implementationHash: operation.implementationHash ?? null,
      enabled: operation.enabled?.() ?? true,
      effectClass: operation.effectClass,
      verb: operation.verb,
    };
  }
}

export interface RuntimeEffectOutcome {
  state: EffectRecord['state'];
  output?: unknown;
  evidenceRef?: string;
}

export interface RuntimeReadOutcome {
  state: 'succeeded' | 'failed';
  output: unknown;
  evidenceRef: string;
}

export interface AdmittedPlanAuthority {
  readonly adapterVersions: ReadonlyMap<string, string>;
  readonly allowedEffectClasses: ReadonlySet<string>;
}

export function admittedPlanAuthority(plan: AdmittedPlanSummary): AdmittedPlanAuthority {
  return {
    adapterVersions: new Map(
      [...plan.adapterVersions].map(([adapter, version]) => [adapter, String(version)]),
    ),
    allowedEffectClasses: new Set(plan.effectUpperBound),
  };
}

export interface EffectProposal {
  effectId: string;
  executionId: string;
  processId: string;
  stepId: string;
  attemptId: string;
  principal: string;
  adapterId: string;
  adapterVersion: string;
  verb: string;
  resource: string;
  normalizedInput: unknown;
  capabilityId: string;
  approvalId?: string;
  idempotencyKey: string;
  budgetReservation: bigint;
  now: number;
}

export interface EffectBrokerHooks {
  boundary?(name: EffectBoundary, effect: EffectRecord): void | Promise<void>;
}

export type EffectBoundary =
  | 'prepared-committed'
  | 'dispatching-committed'
  | 'adapter-returned'
  | 'outcome-committed'
  | 'reconciling-committed';

export class RuntimeEffectBroker {
  constructor(
    private readonly store: SemanticRuntimeStore,
    private readonly policy: RuntimePolicyAdapter,
    private readonly adapters: RuntimeAdapterRegistry,
    private readonly plan: AdmittedPlanAuthority,
    private readonly hooks: EffectBrokerHooks = {},
  ) {}

  readOutcome(effectId: string): RuntimeEffectOutcome | null {
    const effect = this.store.effect(effectId);
    if (!effect) return null;
    const transition = this.store.effectTransitions(effectId).at(-1);
    return {
      state: effect.state,
      ...(transition?.cbor.byteLength ? { output: decode(transition.cbor) } : {}),
      ...(transition?.evidenceRef ? { evidenceRef: transition.evidenceRef } : {}),
    };
  }

  /** Authorize and dispatch a pure read without creating a protected effect journal entry. */
  async dispatchRead(proposal: EffectProposal): Promise<RuntimeReadOutcome> {
    const operation = this.requirePlanAdapter(proposal.adapterId, proposal.adapterVersion);
    if (operation.effectClass !== 'read') {
      throw new Error('only pure reads may bypass the protected effect journal');
    }
    if (operation.verb !== proposal.verb) throw new Error('effect verb does not match adapter schema');
    const input = operation.validateInput(proposal.normalizedInput);
    const requestDigest = computeEffectRequestDigest(
      proposal.adapterId,
      proposal.adapterVersion,
      proposal.verb,
      proposal.resource,
      input,
    );
    const { policyDecisionId } = await this.authorize(proposal, requestDigest);
    const result = await operation.dispatch(Object.freeze({
      effectId: proposal.effectId,
      attemptId: proposal.attemptId,
      requestDigest,
      capabilityId: proposal.capabilityId,
      policyDecisionId,
    }), input);
    return { state: result.status, output: result.output, evidenceRef: result.evidenceRef };
  }

  async prepareEffect(proposal: EffectProposal): Promise<EffectRecord> {
    const operation = this.requirePlanAdapter(proposal.adapterId, proposal.adapterVersion);
    if (operation.effectClass === 'read') {
      throw new Error('pure reads do not use the protected effect journal');
    }
    if (operation.verb !== proposal.verb) throw new Error('effect verb does not match adapter schema');
    const input = operation.validateInput(proposal.normalizedInput);
    const normalizedInput = encodeCanonical(input);
    const requestDigest = computeEffectRequestDigest(
      proposal.adapterId,
      proposal.adapterVersion,
      proposal.verb,
      proposal.resource,
      input,
    );
    const existing = this.store.effect(proposal.effectId);
    if (existing) {
      if (
        existing.executionId !== proposal.executionId
        || existing.processId !== proposal.processId
        || existing.stepId !== proposal.stepId
        || existing.attemptId !== proposal.attemptId
        || existing.idempotencyKey !== proposal.idempotencyKey
        || existing.adapterId !== proposal.adapterId
        || existing.adapterVersion !== proposal.adapterVersion
        || existing.verb !== proposal.verb
        || existing.resource !== proposal.resource
        || existing.capabilityId !== proposal.capabilityId
        || existing.approvalId !== (proposal.approvalId ?? null)
        || existing.budgetReservation !== proposal.budgetReservation
        || !bytesEqual(existing.normalizedInput, normalizedInput)
        || !bytesEqual(existing.requestDigest, requestDigest)
      ) {
        throw new Error('effect identity was reused with different proposal semantics');
      }
      return existing;
    }
    const approvalId = this.requireApproval(proposal, operation.effectClass, requestDigest);
    const { decision: policyDecision, policyDecisionId } =
      await this.authorize(proposal, requestDigest);
    const effect = this.store.prepareEffect({
      effectId: proposal.effectId,
      executionId: proposal.executionId,
      processId: proposal.processId,
      stepId: proposal.stepId,
      attemptId: proposal.attemptId,
      idempotencyKey: proposal.idempotencyKey,
      idempotencyClass: operation.idempotencyClass,
      requestDigest,
      normalizedInput,
      capabilityId: proposal.capabilityId,
      policyDecisionId,
      approvalId,
      adapterId: proposal.adapterId,
      adapterVersion: proposal.adapterVersion,
      verb: proposal.verb,
      resource: proposal.resource,
      reconciliationRule: operation.reconciliationRule,
      compensationRule: operation.compensationRule ?? null,
      budgetReservation: proposal.budgetReservation,
      preparedAt: proposal.now,
      authorization: {
        decisionId: policyDecisionId,
        policyId: policyDecision.policyId,
        policyEpoch: policyDecision.policyEpoch,
        factsDigest: policyDecision.factsDigest,
        principal: proposal.principal,
        reasonCode: policyDecision.reasonCode,
      },
    });
    await this.hooks.boundary?.('prepared-committed', effect);
    return effect;
  }

  async dispatchPrepared(effectId: string, now: number): Promise<EffectRecord> {
    const prepared = requireValue(this.store.effect(effectId), 'prepared effect does not exist');
    if (prepared.state !== 'prepared') {
      throw new Error(`effect ${effectId} is ${prepared.state}; dispatch requires prepared`);
    }
    const operation = this.requirePlanAdapter(prepared.adapterId, prepared.adapterVersion);
    const capability = this.revalidatePreparedCapability(prepared, operation, now);
    const metadata = decodeCapabilityMetadata(capability.metadataCbor);
    const currentPolicy = await this.policy.evaluate({
      executionId: prepared.executionId,
      principal: metadata.subject,
      capabilityId: prepared.capabilityId,
      adapterId: prepared.adapterId,
      adapterVersion: prepared.adapterVersion,
      verb: prepared.verb,
      resource: prepared.resource,
      requestDigest: prepared.requestDigest,
      policyEpoch: capability.policyEpoch,
    });
    if (currentPolicy.decision !== 'allow' || currentPolicy.policyEpoch !== capability.policyEpoch) {
      throw new Error('prepared effect failed final pinned-policy authorization');
    }
    assertDigest(currentPolicy.factsDigest, 'current policy facts digest');
    if (prepared.approvalId) {
      const approval = requireValue(
        this.store.approval(prepared.approvalId),
        'prepared approval disappeared',
      );
      if (
        approval.executionId !== prepared.executionId
        || approval.effectClass !== operation.effectClass
        || approval.principal !== metadata.subject
        || now < approval.notBefore
        || now >= approval.expiresAt
        || !bytesEqual(approval.requestDigest, prepared.requestDigest)
        || (approval.oneShot && approval.consumedAt === null)
      ) {
        throw new Error('prepared effect failed final approval checks');
      }
    }
    const input = operation.validateInput(decode(prepared.normalizedInput));
    const dispatching = this.store.transitionEffect(
      effectId,
      'dispatching',
      `attempt:${prepared.attemptId}`,
      new Uint8Array(),
      now,
    );
    await this.hooks.boundary?.('dispatching-committed', dispatching);
    const token: PreparedEffectToken = Object.freeze({
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      requestDigest: Uint8Array.from(prepared.requestDigest),
      capabilityId: prepared.capabilityId,
      policyDecisionId: prepared.policyDecisionId,
    });
    try {
      const result = await operation.dispatch(token, input);
      await this.hooks.boundary?.('adapter-returned', dispatching);
      const next = result.status;
      const outcome = this.store.transitionEffect(
        effectId,
        next,
        result.evidenceRef,
        encodeCanonical(result.output),
        now,
      );
      await this.hooks.boundary?.('outcome-committed', outcome);
      return outcome;
    } catch (error) {
      const current = requireValue(this.store.effect(effectId), 'effect disappeared during dispatch');
      if (current.state !== 'dispatching') throw error;
      const ambiguous = operation.couldHaveReachedTarget(error);
      return this.store.transitionEffect(
        effectId,
        ambiguous ? 'unknown' : 'failed',
        ambiguous ? 'adapter-dispatch-ambiguous' : 'adapter-definitive-failure',
        encodeCanonical({ error: safeErrorCode(error) }),
        now,
      );
    }
  }

  async reconcileUnknown(effectId: string, now: number): Promise<EffectRecord> {
    const unknown = requireValue(this.store.effect(effectId), 'effect does not exist');
    if (unknown.state !== 'unknown' && unknown.state !== 'reconciling') {
      throw new Error('only unknown/reconciling effects can reconcile');
    }
    const operation = this.requirePlanAdapter(unknown.adapterId, unknown.adapterVersion);
    const input = operation.validateInput(decode(unknown.normalizedInput));
    const reconciling = unknown.state === 'unknown'
      ? this.store.transitionEffect(
        effectId,
        'reconciling',
        'read-only-reconciliation-started',
        new Uint8Array(),
        now,
      )
      : unknown;
    if (unknown.state === 'unknown') {
      await this.hooks.boundary?.('reconciling-committed', reconciling);
    }
    const result = await operation.reconcile(reconciling, input);
    if (result.status === 'unknown') {
      return this.store.transitionEffect(
        effectId,
        'manual_review_required',
        result.evidenceRef,
        encodeCanonical(result.output ?? null),
        now,
      );
    }
    this.store.transitionEffect(
      effectId,
      'reconciled',
      result.evidenceRef,
      encodeCanonical(result.output ?? null),
      now,
    );
    return this.store.transitionEffect(
      effectId,
      result.status === 'applied' ? 'succeeded' : 'failed',
      result.evidenceRef,
      encodeCanonical(result.output ?? null),
      now,
    );
  }

  private requirePlanAdapter(id: string, version: string): RuntimeAdapterOperation {
    if (this.plan.adapterVersions.get(id) !== version) {
      throw new Error(`adapter ${id}@${version} is not pinned by the admitted plan`);
    }
    const operation = requireRegistry(this.adapters).get(adapterKey(id, version));
    if (!operation) throw new Error(`adapter ${id}@${version} is not registered`);
    if (!this.plan.allowedEffectClasses.has(operation.effectClass)) {
      throw new Error(`effect class ${operation.effectClass} is outside the admitted upper bound`);
    }
    return operation;
  }

  private async authorize(proposal: EffectProposal, requestDigest: Uint8Array) {
    const capability = this.requireActiveCapability(proposal, requestDigest);
    const execution = requireValue(
      this.store.execution(proposal.executionId),
      'runtime execution does not exist',
    );
    if (execution.status !== 'active' || execution.policyEpoch !== capability.policyEpoch) {
      throw new Error('runtime execution is inactive or has a stale policy epoch');
    }
    const decision = await this.policy.evaluate({
      executionId: proposal.executionId,
      principal: proposal.principal,
      capabilityId: proposal.capabilityId,
      adapterId: proposal.adapterId,
      adapterVersion: proposal.adapterVersion,
      verb: proposal.verb,
      resource: proposal.resource,
      requestDigest,
      policyEpoch: capability.policyEpoch,
    });
    if (decision.decision !== 'allow') {
      throw new Error(`runtime policy denied request: ${decision.reasonCode}`);
    }
    if (decision.policyEpoch !== capability.policyEpoch) {
      throw new Error('runtime policy decision epoch does not match capability epoch');
    }
    assertDigest(decision.factsDigest, 'policy facts digest');
    return {
      decision,
      policyDecisionId: digestHex(
        'DKG-SEMANTIC-RUNTIME-POLICY-DECISION-V1\0',
        proposal.effectId,
        decision.policyId,
        decision.policyEpoch.toString(),
        decision.factsDigest,
      ),
    };
  }

  private requireActiveCapability(
    proposal: EffectProposal,
    requestDigest: Uint8Array,
  ): CapabilityRecord {
    const capability = requireValue(
      this.store.capability(proposal.capabilityId),
      'effect capability does not exist',
    );
    const metadata = decodeCapabilityMetadata(capability.metadataCbor);
    if (
      capability.executionId !== proposal.executionId
      || metadata.executionId !== proposal.executionId
      || metadata.subject !== proposal.principal
      || metadata.audience !== 'dkg-semantic-runtime'
      || capability.revokedAt !== null
      || capability.oneShot !== metadata.oneShot
      || (capability.oneShot && capability.consumedAt !== null)
      || proposal.now < capability.notBefore
      || proposal.now >= capability.expiresAt
      || !metadata.verbs.includes(proposal.verb)
      || !metadata.resources.some((scope) => resourceContains(scope, proposal.resource))
      || proposal.budgetReservation > metadata.budgetMicros
    ) {
      throw new Error('effect capability is inactive or does not cover the request');
    }
    assertDigest(requestDigest, 'request digest');
    return capability;
  }

  private requireApproval(
    proposal: EffectProposal,
    effectClass: string,
    requestDigest: Uint8Array,
  ): string | null {
    // Both effects are explicitly admitted and operator-policy-gated. Remote
    // execution additionally carries a wallet-signed, target-bound delegation.
    if (effectClass === 'model-invocation' || effectClass === 'remote-execution') return null;
    if (!proposal.approvalId) throw new Error(`effect class ${effectClass} requires approval`);
    const approval = requireValue(
      this.store.approval(proposal.approvalId),
      'effect approval does not exist',
    );
    if (
      approval.executionId !== proposal.executionId
      || approval.effectClass !== effectClass
      || approval.principal !== proposal.principal
      || proposal.now < approval.notBefore
      || proposal.now >= approval.expiresAt
      || (approval.oneShot && approval.consumedAt !== null)
      || !bytesEqual(approval.requestDigest, requestDigest)
    ) {
      throw new Error('effect approval is inactive or does not match the request');
    }
    return proposal.approvalId;
  }

  private revalidatePreparedCapability(
    effect: EffectRecord,
    operation: RuntimeAdapterOperation,
    now: number,
  ): CapabilityRecord {
    const capability = requireValue(
      this.store.capability(effect.capabilityId),
      'prepared capability disappeared',
    );
    const execution = requireValue(
      this.store.execution(effect.executionId),
      'prepared execution disappeared',
    );
    if (
      execution.status !== 'active'
      || capability.executionId !== effect.executionId
      || capability.revokedAt !== null
      || (capability.oneShot && capability.consumedAt === null)
      || now < capability.notBefore
      || now >= capability.expiresAt
      || operation.idempotencyClass !== effect.idempotencyClass
    ) {
      throw new Error('prepared effect failed final gateway authorization checks');
    }
    const expectedDigest = digest(
      'DKG-SEMANTIC-RUNTIME-EFFECT-REQUEST-V1\0',
      effect.adapterId,
      effect.adapterVersion,
      effect.verb,
      effect.resource,
      effect.normalizedInput,
    );
    const metadata = decodeCapabilityMetadata(capability.metadataCbor);
    if (
      operation.verb !== effect.verb
      || metadata.executionId !== effect.executionId
      || metadata.audience !== 'dkg-semantic-runtime'
      || capability.oneShot !== metadata.oneShot
      || capability.policyEpoch !== execution.policyEpoch
      || effect.budgetReservation > metadata.budgetMicros
      || !metadata.verbs.includes(effect.verb)
      || !metadata.resources.some((scope) => resourceContains(scope, effect.resource))
      || !bytesEqual(expectedDigest, effect.requestDigest)
    ) {
      throw new Error('prepared request no longer passes final gateway binding checks');
    }
    return capability;
  }
}

export function encodeCapabilityMetadata(metadata: RuntimeCapabilityMetadata): Uint8Array {
  if (
    !metadata.subject
    || !metadata.audience
    || !metadata.executionId
    || metadata.delegationDepth < 0
    || !Number.isInteger(metadata.delegationDepth)
    || metadata.budgetMicros < 0n
  ) {
    throw new Error('invalid runtime capability metadata');
  }
  const verbs = [...new Set(metadata.verbs)].sort();
  const resources = [...new Set(metadata.resources)].sort();
  return encode([
    1,
    metadata.subject,
    metadata.audience,
    metadata.executionId,
    verbs,
    resources,
    metadata.delegationDepth,
    metadata.oneShot,
    metadata.budgetMicros,
    metadata.parentCapabilityId ?? null,
  ]);
}

export function computeEffectRequestDigest(
  adapterId: string,
  adapterVersion: string,
  verb: string,
  resource: string,
  normalizedInput: unknown,
): Uint8Array {
  return digest(
    'DKG-SEMANTIC-RUNTIME-EFFECT-REQUEST-V1\0',
    adapterId,
    adapterVersion,
    verb,
    resource,
    encodeCanonical(normalizedInput),
  );
}

export function decodeCapabilityMetadata(bytes: Uint8Array): RuntimeCapabilityMetadata {
  const value = decode(bytes);
  if (!Array.isArray(value) || value.length !== 10 || value[0] !== 1) {
    throw new Error('invalid runtime capability metadata envelope');
  }
  const [,
    subject,
    audience,
    executionId,
    verbs,
    resources,
    delegationDepth,
    oneShot,
    budgetMicros,
    parentCapabilityId,
  ] = value;
  if (
    typeof subject !== 'string'
    || typeof audience !== 'string'
    || typeof executionId !== 'string'
    || !Array.isArray(verbs)
    || !verbs.every((item) => typeof item === 'string')
    || !Array.isArray(resources)
    || !resources.every((item) => typeof item === 'string')
    || typeof delegationDepth !== 'number'
    || !Number.isInteger(delegationDepth)
    || typeof oneShot !== 'boolean'
    || (typeof budgetMicros !== 'bigint' && typeof budgetMicros !== 'number')
    || (parentCapabilityId !== null && typeof parentCapabilityId !== 'string')
  ) {
    throw new Error('invalid runtime capability metadata fields');
  }
  return {
    subject,
    audience,
    executionId,
    verbs: verbs as string[],
    resources: resources as string[],
    delegationDepth,
    oneShot,
    budgetMicros: BigInt(budgetMicros),
    parentCapabilityId: parentCapabilityId ?? undefined,
  };
}

function requireRegistry(registry: RuntimeAdapterRegistry): Map<string, RuntimeAdapterOperation> {
  const operations = REGISTERED_ADAPTERS.get(registry);
  if (!operations) throw new Error('adapter registry is not initialized');
  return operations;
}

function adapterKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function resourceContains(scope: string, requested: string): boolean {
  if (scope === requested) return true;
  return scope.endsWith('/*') && requested.startsWith(scope.slice(0, -1));
}

function encodeCanonical(value: unknown): Uint8Array {
  assertCborSafe(value, 0, new Set());
  return encode(value);
}

function assertCborSafe(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > 32) throw new Error('adapter input exceeds maximum CBOR nesting');
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || (typeof value === 'number' && Number.isSafeInteger(value))
    || value instanceof Uint8Array
  ) return;
  if (typeof value !== 'object') throw new Error('adapter input contains an unsupported CBOR value');
  if (seen.has(value)) throw new Error('adapter input contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertCborSafe(child, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('adapter input must use plain objects');
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 256) throw new Error('adapter input map key is too long');
      assertCborSafe(child, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function digest(domain: string, ...parts: Array<string | Uint8Array>): Uint8Array {
  const hash = createHash('sha256');
  hash.update(domain);
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return Uint8Array.from(hash.digest());
}

function digestHex(domain: string, ...parts: Array<string | Uint8Array>): string {
  return Buffer.from(digest(domain, ...parts)).toString('hex');
}

function assertDigest(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`${name} must be exactly 32 bytes`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]{1,128}$/.test(error.message)) return error.message;
  return 'ADAPTER_DISPATCH_FAILED';
}
