import { WalControlStoreError } from '../control/errors.js';
import { WalProtocolError } from '../protocol/errors.js';
import { verifyWalObjectV1 } from '../protocol/wal-object.js';
import { walObjectId, type WalObjectId } from '../reconciliation/ids.js';
import { admissionError, WalAdmissionError } from './errors.js';
import type {
  WalAdmissionCandidate,
  WalAdmissionDependencyRequest,
  WalAdmissionDependencyRole,
  WalAdmissionInternalObject,
  WalAdmissionOptions,
  WalAdmissionPayloadAnalysis,
  WalAdmissionReasonCode,
  WalAdmissionResult,
  WalAdmissionValidation,
  WalAdmissionVerifiedObject,
} from './types.js';

const DEFAULT_MAXIMUM_OBJECT_BYTES = 1_073_741_824;
const DEFAULT_MAXIMUM_CLOSURE_OBJECTS = 4_096;
const DEFAULT_MAXIMUM_CLOSURE_BYTES = 1_073_741_824;
const DEFAULT_MAXIMUM_CLOSURE_DEPTH = 256;
const DEFAULT_MAXIMUM_REFERENCES_PER_OBJECT = 4_096;
const DEFAULT_MAXIMUM_LOGICAL_KEYS_PER_OBJECT = 4_096;
const MAXIMUM_ADAPTER_VERSION = 65_535;

type FailureKind = 'blocked' | 'quarantined';

class AdmissionFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly reasonCode: WalAdmissionReasonCode,
    readonly root: WalAdmissionCandidate,
    readonly related: WalAdmissionCandidate,
    readonly missingObjectIds: readonly WalObjectId[] = [],
  ) {
    super(reasonCode);
    this.name = 'AdmissionFailure';
  }
}

interface QueueItem {
  candidate: WalAdmissionCandidate;
  depth: number;
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', `${name} must be an integer in 1..${maximum}`);
  }
  return value;
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'admission clock must return a non-negative safe integer');
  }
  return value;
}

function candidate(value: WalAdmissionCandidate): WalAdmissionCandidate {
  if (!value || !(value.objectId instanceof Uint8Array) || value.objectId.length !== 32) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate objectId must be exactly 32 bytes');
  }
  if (!(value.canonicalBytes instanceof Uint8Array) || value.canonicalBytes.length === 0) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate canonicalBytes cannot be empty');
  }
  if (!(value.providerPeerId instanceof Uint8Array) || value.providerPeerId.length === 0) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate providerPeerId cannot be empty');
  }
  if (!['local', 'network', 'backfill', 'replay'].includes(value.ingress)) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate ingress is unsupported');
  }
  if (value.visibility !== 'public' && value.visibility !== 'private') {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate visibility is unsupported');
  }
  if (value.storageOrigin !== undefined && !['REMOTE', 'GENESIS', 'SNAPSHOT'].includes(value.storageOrigin)) {
    admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'candidate storageOrigin is unsupported');
  }
  const optional = (input: Uint8Array | null | undefined, name: string): Uint8Array | null | undefined => {
    if (input === undefined || input === null) return input;
    if (!(input instanceof Uint8Array)) admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', `${name} must be bytes`);
    return copy(input);
  };
  return Object.freeze({
    objectId: copy(value.objectId),
    canonicalBytes: copy(value.canonicalBytes),
    providerPeerId: copy(value.providerPeerId),
    ingress: value.ingress,
    visibility: value.visibility,
    checkpointProofBytes: optional(value.checkpointProofBytes, 'checkpointProofBytes'),
    closureProofBytes: optional(value.closureProofBytes, 'closureProofBytes'),
    storageOrigin: value.storageOrigin,
  });
}

function ids(
  values: readonly Uint8Array[],
  maximum: number,
  root: WalAdmissionCandidate,
  related: WalAdmissionCandidate,
  limitReason: WalAdmissionReasonCode,
): WalObjectId[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new AdmissionFailure('quarantined', limitReason, root, related);
  }
  const output: WalObjectId[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!(value instanceof Uint8Array) || value.length !== 32) {
      throw new AdmissionFailure('quarantined', 'PAYLOAD_INVALID', root, related);
    }
    const id = walObjectId(value);
    const key = hex(id);
    if (seen.has(key)) throw new AdmissionFailure('quarantined', 'PAYLOAD_INVALID', root, related);
    seen.add(key);
    output.push(id);
  }
  output.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return output;
}

function normalizeAnalysis(
  value: WalAdmissionPayloadAnalysis,
  root: WalAdmissionCandidate,
  related: WalAdmissionCandidate,
  maximumReferences: number,
  maximumLogicalKeys: number,
): WalAdmissionPayloadAnalysis {
  if (!value || !Number.isSafeInteger(value.adapterVersion) || value.adapterVersion < 0 || value.adapterVersion > MAXIMUM_ADAPTER_VERSION) {
    throw new AdmissionFailure('quarantined', 'PAYLOAD_INVALID', root, related);
  }
  const logicalKeys = ids(value.logicalKeys, maximumLogicalKeys, root, related, 'LOGICAL_KEY_LIMIT_EXCEEDED');
  const parents = ids(value.parents, maximumReferences, root, related, 'REFERENCE_LIMIT_EXCEEDED');
  const baseHeads = ids(value.baseHeads, maximumReferences, root, related, 'REFERENCE_LIMIT_EXCEEDED');
  const contentObjectIds = ids(value.contentObjectIds ?? [], maximumReferences, root, related, 'REFERENCE_LIMIT_EXCEEDED');
  const vmEvidenceObjectIds = ids(value.vmEvidenceObjectIds ?? [], maximumReferences, root, related, 'REFERENCE_LIMIT_EXCEEDED');
  const referenceCount = parents.length + baseHeads.length + contentObjectIds.length + vmEvidenceObjectIds.length
    + (value.policyObjectId === null ? 0 : 1);
  if (referenceCount > maximumReferences) {
    throw new AdmissionFailure('quarantined', 'REFERENCE_LIMIT_EXCEEDED', root, related);
  }
  let policyObjectId: WalObjectId | null = null;
  if (value.policyObjectId !== null) {
    if (!(value.policyObjectId instanceof Uint8Array) || value.policyObjectId.length !== 32) {
      throw new AdmissionFailure('quarantined', 'PAYLOAD_INVALID', root, related);
    }
    policyObjectId = walObjectId(value.policyObjectId);
  }
  return Object.freeze({
    adapterVersion: value.adapterVersion,
    logicalKeys,
    parents,
    baseHeads,
    policyObjectId,
    contentObjectIds,
    vmEvidenceObjectIds,
    carriesChainEvidence: value.carriesChainEvidence === true,
    carriesVmEvidence: value.carriesVmEvidence === true,
  });
}

function references(
  object: WalAdmissionInternalObject,
  maximum: number,
  root: WalAdmissionCandidate,
): Array<{ id: WalObjectId; role: WalAdmissionDependencyRole }> {
  const values: Array<{ id: WalObjectId; role: WalAdmissionDependencyRole }> = [];
  const append = (id: Uint8Array, role: WalAdmissionDependencyRole): void => {
    values.push({ id: walObjectId(id), role });
  };
  if (object.verified.tuple[5] !== null) append(object.verified.tuple[5], 'parent');
  for (const id of object.analysis.parents) append(id, 'parent');
  for (const id of object.analysis.baseHeads) append(id, 'base-head');
  if (object.analysis.policyObjectId !== null) append(object.analysis.policyObjectId, 'policy');
  for (const id of object.analysis.contentObjectIds!) append(id, 'content');
  for (const id of object.analysis.vmEvidenceObjectIds!) append(id, 'vm-evidence');
  const unique = new Map<string, { id: WalObjectId; role: WalAdmissionDependencyRole }>();
  for (const value of values) unique.set(`${value.role}:${hex(value.id)}`, value);
  if (unique.size > maximum) {
    throw new AdmissionFailure('quarantined', 'REFERENCE_LIMIT_EXCEEDED', root, object.candidate);
  }
  return [...unique.values()].sort((left, right) => left.role.localeCompare(right.role)
    || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield copy(bytes);
}

function asVerified(object: WalAdmissionInternalObject): WalAdmissionVerifiedObject {
  return Object.freeze({
    candidate: object.candidate,
    verified: object.verified,
    inspection: object.inspection,
    analysis: object.analysis,
  });
}

function immutableResult<T extends WalAdmissionValidation | WalAdmissionResult>(value: T): T {
  return Object.freeze({
    ...value,
    missingObjectIds: Object.freeze(value.missingObjectIds.map(id => walObjectId(id))),
    objects: Object.freeze(value.objects.map(object => Object.freeze(object))),
  }) as T;
}

export class WalAdmissionPipeline {
  readonly maximumObjectBytes: number;
  readonly maximumClosureObjects: number;
  readonly maximumClosureBytes: number;
  readonly maximumClosureDepth: number;
  readonly maximumReferencesPerObject: number;
  readonly maximumLogicalKeysPerObject: number;
  readonly supportedAdapterVersions: ReadonlySet<number>;
  private readonly now: () => number;

  constructor(private readonly options: WalAdmissionOptions) {
    if (!options?.adapter || !options.state || !options.objects || typeof options.fetchDependency !== 'function') {
      admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'admission adapter, state, object store, and dependency fetcher are required');
    }
    if (!Array.isArray(options.supportedAdapterVersions) || options.supportedAdapterVersions.length === 0) {
      admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'at least one supported adapter version is required');
    }
    const versions = options.supportedAdapterVersions.map(version => positiveInteger(version, 'adapter version', MAXIMUM_ADAPTER_VERSION));
    if (new Set(versions).size !== versions.length) {
      admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'supported adapter versions must be unique');
    }
    this.supportedAdapterVersions = new Set(versions);
    this.maximumObjectBytes = positiveInteger(options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES, 'maximumObjectBytes', DEFAULT_MAXIMUM_OBJECT_BYTES);
    this.maximumClosureObjects = positiveInteger(options.maximumClosureObjects ?? DEFAULT_MAXIMUM_CLOSURE_OBJECTS, 'maximumClosureObjects', DEFAULT_MAXIMUM_CLOSURE_OBJECTS);
    this.maximumClosureBytes = positiveInteger(options.maximumClosureBytes ?? DEFAULT_MAXIMUM_CLOSURE_BYTES, 'maximumClosureBytes', DEFAULT_MAXIMUM_CLOSURE_BYTES);
    this.maximumClosureDepth = positiveInteger(options.maximumClosureDepth ?? DEFAULT_MAXIMUM_CLOSURE_DEPTH, 'maximumClosureDepth', DEFAULT_MAXIMUM_CLOSURE_DEPTH);
    this.maximumReferencesPerObject = positiveInteger(options.maximumReferencesPerObject ?? DEFAULT_MAXIMUM_REFERENCES_PER_OBJECT, 'maximumReferencesPerObject', DEFAULT_MAXIMUM_REFERENCES_PER_OBJECT);
    this.maximumLogicalKeysPerObject = positiveInteger(options.maximumLogicalKeysPerObject ?? DEFAULT_MAXIMUM_LOGICAL_KEYS_PER_OBJECT, 'maximumLogicalKeysPerObject', DEFAULT_MAXIMUM_LOGICAL_KEYS_PER_OBJECT);
    if (options.now !== undefined && typeof options.now !== 'function') {
      admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'admission clock must be a function');
    }
    this.now = options.now ?? Date.now;
  }

  async validate(rootInput: WalAdmissionCandidate, options: { signal?: AbortSignal } = {}): Promise<WalAdmissionValidation> {
    const root = candidate(rootInput);
    try {
      const built = await this.buildClosure(root, false, options.signal);
      return immutableResult({
        status: 'valid', reasonCode: null, rootObjectId: walObjectId(root.objectId),
        missingObjectIds: [], objects: built.map(asVerified),
      });
    } catch (error) {
      if (!(error instanceof AdmissionFailure)) throw error;
      return this.validationFailure(error);
    }
  }

  async admit(rootInput: WalAdmissionCandidate, options: { signal?: AbortSignal } = {}): Promise<WalAdmissionResult> {
    const root = candidate(rootInput);
    if (root.ingress === 'local') {
      admissionError('WAL_ADMISSION_INVALID_CONFIGURATION', 'local ingress must call shared validate before the WAL-013 local commit transaction');
    }
    const rootId = walObjectId(root.objectId);
    const existing = this.options.state.getAdmission(rootId);
    if (existing?.state === 'ADMITTED') {
      return immutableResult({
        status: 'already-admitted', reasonCode: null, rootObjectId: rootId,
        missingObjectIds: [], objects: [],
      });
    }
    if (existing?.state === 'QUARANTINED') {
      return immutableResult({
        status: 'quarantined', reasonCode: existing.reasonCode as WalAdmissionReasonCode,
        rootObjectId: rootId, relatedObjectId: rootId, missingObjectIds: [], objects: [],
      });
    }
    try {
      const built = await this.buildClosure(root, true, options.signal);
      for (const object of built) {
        await this.options.objects.put(object.objectId, oneChunk(object.candidate.canonicalBytes));
      }
      const atMs = currentTime(this.now);
      await this.options.state.admitRemoteBatch(built.map(object => ({
        objectId: object.objectId,
        object: object.verified.tuple,
        canonicalLength: object.candidate.canonicalBytes.length,
        origin: object.candidate.storageOrigin ?? (object.candidate.ingress === 'backfill' ? 'GENESIS' : 'REMOTE'),
        logicalKeys: object.analysis.logicalKeys,
      })), atMs);
      return immutableResult({
        status: 'admitted', reasonCode: null, rootObjectId: rootId,
        missingObjectIds: [], objects: built.map(asVerified),
      });
    } catch (error) {
      if (error instanceof WalAdmissionError) throw error;
      if (error instanceof AdmissionFailure) return this.persistFailure(error);
      const failure = new AdmissionFailure('blocked', 'PERSISTENCE_FAILED', root, root);
      return this.persistFailure(failure, error);
    }
  }

  private async buildClosure(
    root: WalAdmissionCandidate,
    persist: boolean,
    signal?: AbortSignal,
  ): Promise<WalAdmissionInternalObject[]> {
    const queue: QueueItem[] = [{ candidate: root, depth: 0 }];
    const scheduled = new Set<string>([hex(root.objectId)]);
    const built = new Map<string, WalAdmissionInternalObject>();
    const missing = new Map<string, WalObjectId>();
    let closureBytes = 0;

    while (queue.length > 0) {
      if (signal?.aborted) throw new AdmissionFailure('blocked', 'DEPENDENCY_UNAVAILABLE', root, root);
      const item = queue.shift()!;
      const current = candidate(item.candidate);
      const key = hex(current.objectId);
      if (this.options.state.getWalObjectMetadata(current.objectId) !== null) continue;
      if (built.size + 1 > this.maximumClosureObjects) {
        throw new AdmissionFailure('quarantined', 'CLOSURE_OBJECT_LIMIT_EXCEEDED', root, current);
      }
      closureBytes += current.canonicalBytes.length;
      if (closureBytes > this.maximumClosureBytes) {
        throw new AdmissionFailure('quarantined', 'CLOSURE_BYTE_LIMIT_EXCEEDED', root, current);
      }
      if (persist) this.stage(current);
      const object = await this.verifyObject(root, current, item.depth);
      object.references = references(object, this.maximumReferencesPerObject, root);
      built.set(key, object);

      for (const reference of object.references) {
        const referenceKey = hex(reference.id);
        if (this.options.state.getWalObjectMetadata(reference.id) !== null || built.has(referenceKey) || scheduled.has(referenceKey)) continue;
        if (item.depth + 1 > this.maximumClosureDepth) {
          throw new AdmissionFailure('quarantined', 'CLOSURE_DEPTH_EXCEEDED', root, current);
        }
        scheduled.add(referenceKey);
        const request: WalAdmissionDependencyRequest = {
          objectId: reference.id,
          role: reference.role,
          requestedByObjectId: object.objectId,
          depth: item.depth + 1,
        };
        let fetched: WalAdmissionCandidate | null = null;
        try {
          fetched = await this.options.fetchDependency(request, { signal });
        } catch {
          fetched = null;
        }
        if (fetched === null) {
          missing.set(referenceKey, reference.id);
          continue;
        }
        let exact: WalAdmissionCandidate;
        try {
          exact = candidate(fetched);
        } catch {
          throw new AdmissionFailure('quarantined', 'DEPENDENCY_INVALID', root, current);
        }
        if (!equalBytes(exact.objectId, reference.id)) {
          throw new AdmissionFailure('quarantined', 'DEPENDENCY_INVALID', root, exact);
        }
        queue.push({ candidate: exact, depth: item.depth + 1 });
      }
    }

    if (missing.size > 0) {
      const missingIds = [...missing.values()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      throw new AdmissionFailure('blocked', 'DEPENDENCY_UNAVAILABLE', root, root, missingIds);
    }
    this.assertAcyclic(root, built);
    this.assertLaneLinks(root, built);
    await this.validateSemanticClosure(root, built);
    return [...built.values()].sort((left, right) => hex(left.objectId).localeCompare(hex(right.objectId)));
  }

  private async verifyObject(
    root: WalAdmissionCandidate,
    current: WalAdmissionCandidate,
    depth: number,
  ): Promise<WalAdmissionInternalObject> {
    if (current.canonicalBytes.length > this.maximumObjectBytes) {
      throw new AdmissionFailure('quarantined', 'CLOSURE_BYTE_LIMIT_EXCEEDED', root, current);
    }
    let verified;
    try {
      verified = verifyWalObjectV1(current.canonicalBytes);
    } catch (error) {
      throw new AdmissionFailure(
        'quarantined',
        error instanceof WalProtocolError && error.code === 'WAL_SCHEMA_SEMANTIC'
          ? 'INVALID_LANE_LINK'
          : 'INVALID_WAL_OBJECT',
        root,
        current,
      );
    }
    const objectId = walObjectId(verified.walObjectId);
    if (!equalBytes(objectId, current.objectId)) {
      throw new AdmissionFailure('quarantined', 'WAL_OBJECT_ID_MISMATCH', root, current);
    }
    /* v8 ignore start -- verifyWalObjectV1 enforces this semantic rule before returning. */
    if ((verified.tuple[4] === 0n) !== (verified.tuple[5] === null)) {
      throw new AdmissionFailure('quarantined', 'INVALID_LANE_LINK', root, current);
    }
    /* v8 ignore stop */
    let inspection;
    try {
      inspection = await this.options.adapter.inspectPayload({
        objectId, object: verified.tuple, payloadBytes: copy(verified.payloadBytes), visibility: current.visibility,
      });
      if (!inspection || typeof inspection.privatePayload !== 'boolean') throw new Error('invalid inspection');
    } catch {
      throw new AdmissionFailure('quarantined', 'PAYLOAD_ENVELOPE_INVALID', root, current);
    }
    if ((current.visibility === 'private') !== inspection.privatePayload) {
      throw new AdmissionFailure('quarantined', 'PRIVATE_PAYLOAD_INVALID', root, current);
    }
    if (inspection.privatePayload) {
      let allowed = false;
      try {
        allowed = await this.options.adapter.authorizePrivate({ candidate: current, objectId, object: verified.tuple, inspection });
      } catch {
        allowed = false;
      }
      if (!allowed) throw new AdmissionFailure('quarantined', 'PRIVATE_UNAUTHORIZED', root, current);
    }
    let checkpoint: 'accepted' | 'missing' | 'invalid' = 'invalid';
    try {
      checkpoint = await this.options.adapter.verifyCheckpointInclusion({ candidate: current, objectId, object: verified.tuple });
    } catch {
      checkpoint = 'invalid';
    }
    if (checkpoint === 'missing') throw new AdmissionFailure('blocked', 'CHECKPOINT_UNAVAILABLE', root, current);
    if (checkpoint !== 'accepted') throw new AdmissionFailure('quarantined', 'CHECKPOINT_INVALID', root, current);
    let namespaceAllowed = false;
    try {
      namespaceAllowed = await this.options.adapter.authorizeNamespace({ candidate: current, objectId, object: verified.tuple });
    } catch {
      namespaceAllowed = false;
    }
    if (!namespaceAllowed) throw new AdmissionFailure('quarantined', 'NAMESPACE_UNAUTHORIZED', root, current);
    let rawAnalysis: WalAdmissionPayloadAnalysis;
    try {
      rawAnalysis = await this.options.adapter.openPayload({ candidate: current, objectId, object: verified.tuple, inspection });
    } catch {
      throw new AdmissionFailure('quarantined', inspection.privatePayload ? 'PRIVATE_PAYLOAD_INVALID' : 'PAYLOAD_INVALID', root, current);
    }
    const analysis = normalizeAnalysis(
      rawAnalysis,
      root,
      current,
      this.maximumReferencesPerObject,
      this.maximumLogicalKeysPerObject,
    );
    if (!this.supportedAdapterVersions.has(analysis.adapterVersion)) {
      throw new AdmissionFailure('quarantined', 'ADAPTER_VERSION_UNSUPPORTED', root, current);
    }
    return {
      candidate: current,
      verified,
      objectId,
      inspection,
      analysis,
      depth,
      references: [],
    };
  }

  private assertAcyclic(root: WalAdmissionCandidate, built: ReadonlyMap<string, WalAdmissionInternalObject>): void {
    const colors = new Map<string, 0 | 1 | 2>();
    const visit = (key: string): void => {
      const color = colors.get(key) ?? 0;
      if (color === 1) throw new AdmissionFailure('quarantined', 'CAUSAL_CYCLE', root, built.get(key)!.candidate);
      if (color === 2) return;
      colors.set(key, 1);
      const object = built.get(key)!;
      for (const reference of object.references) {
        const child = hex(reference.id);
        if (built.has(child)) visit(child);
      }
      colors.set(key, 2);
    };
    for (const key of [...built.keys()].sort()) visit(key);
  }

  private assertLaneLinks(root: WalAdmissionCandidate, built: ReadonlyMap<string, WalAdmissionInternalObject>): void {
    const positions = new Map<string, WalAdmissionInternalObject>();
    for (const object of built.values()) {
      const tuple = object.verified.tuple;
      const position = `${hex(tuple[1])}:${hex(tuple[2])}:${tuple[3]}:${tuple[4]}`;
      const prior = positions.get(position);
      if (prior !== undefined && !equalBytes(prior.objectId, object.objectId)) {
        throw new AdmissionFailure('quarantined', 'AUTHOR_EQUIVOCATION', root, object.candidate);
      }
      positions.set(position, object);
      const admitted = this.options.state.findWalObjectAtPosition(tuple[1], tuple[2], tuple[3], tuple[4]);
      if (admitted !== null && !equalBytes(admitted.objectId, object.objectId)) {
        throw new AdmissionFailure('quarantined', 'AUTHOR_EQUIVOCATION', root, object.candidate);
      }
      if (tuple[5] === null) continue;
      const previous = built.get(hex(tuple[5]));
      const metadata = previous === undefined ? this.options.state.getWalObjectMetadata(tuple[5]) : null;
      const sameLane = previous !== undefined
        ? equalBytes(previous.verified.tuple[1], tuple[1])
          && equalBytes(previous.verified.tuple[2], tuple[2])
          && previous.verified.tuple[3] === tuple[3]
          && previous.verified.tuple[4] + 1n === tuple[4]
        : metadata !== null
          && equalBytes(metadata.namespaceId, tuple[1])
          && equalBytes(metadata.writerId, tuple[2])
          && metadata.writerEpoch === tuple[3]
          && metadata.sequence + 1n === tuple[4];
      if (!sameLane) throw new AdmissionFailure('quarantined', 'CAUSAL_LINK_INVALID', root, object.candidate);
    }
  }

  private async validateSemanticClosure(
    root: WalAdmissionCandidate,
    built: ReadonlyMap<string, WalAdmissionInternalObject>,
  ): Promise<void> {
    const closure = new Map([...built].map(([key, object]) => [key, asVerified(object)]));
    for (const object of [...built.values()].sort((left, right) => hex(left.objectId).localeCompare(hex(right.objectId)))) {
      const verified = asVerified(object);
      const admittedPolicy = object.analysis.policyObjectId === null
        ? null
        : this.options.state.getWalObjectMetadata(object.analysis.policyObjectId);
      let policy: 'accepted' | 'missing' | 'invalid' = 'invalid';
      try {
        policy = await this.options.adapter.validatePolicy({ object: verified, closure, admittedPolicy });
      } catch {
        policy = 'invalid';
      }
      if (policy === 'missing') throw new AdmissionFailure('blocked', 'POLICY_UNAVAILABLE', root, object.candidate);
      if (policy !== 'accepted') throw new AdmissionFailure('quarantined', 'POLICY_INVALID', root, object.candidate);

      let scope: 'accepted' | 'cross-view' | 'invalid' = 'invalid';
      try {
        scope = await this.options.adapter.validateReferenceScopes({ object: verified, closure });
      } catch {
        scope = 'invalid';
      }
      if (scope === 'cross-view') throw new AdmissionFailure('quarantined', 'CROSS_VIEW_REFERENCE', root, object.candidate);
      if (scope !== 'accepted') throw new AdmissionFailure('quarantined', 'CAUSAL_LINK_INVALID', root, object.candidate);

      let crossAuthor = false;
      try {
        crossAuthor = await this.options.adapter.validateCrossAuthorReferences({ object: verified, closure });
      } catch {
        crossAuthor = false;
      }
      if (!crossAuthor) throw new AdmissionFailure('quarantined', 'CROSS_AUTHOR_UNAUTHORIZED', root, object.candidate);

      let chain: 'accepted' | 'pending' | 'invalid' = 'invalid';
      try {
        chain = await this.options.adapter.validateChainEvidence({ object: verified, closure });
      } catch {
        chain = 'invalid';
      }
      if (chain === 'pending') throw new AdmissionFailure('blocked', 'CHAIN_EVIDENCE_PENDING', root, object.candidate);
      if (chain !== 'accepted') throw new AdmissionFailure('quarantined', 'CHAIN_EVIDENCE_INVALID', root, object.candidate);

      let vm: 'accepted' | 'pending' | 'invalid' = 'invalid';
      try {
        vm = await this.options.adapter.validateVmEvidence({ object: verified, closure });
      } catch {
        vm = 'invalid';
      }
      if (vm === 'pending') throw new AdmissionFailure('blocked', 'VM_EVIDENCE_PENDING', root, object.candidate);
      if (vm !== 'accepted') throw new AdmissionFailure('quarantined', 'VM_EVIDENCE_INVALID', root, object.candidate);
    }
  }

  private stage(value: WalAdmissionCandidate): void {
    this.options.state.stageAdmission({
      objectId: value.objectId,
      providerPeerId: value.providerPeerId,
      proofBytes: value.checkpointProofBytes,
      closureBytes: value.closureProofBytes,
      updatedAtMs: currentTime(this.now),
    });
  }

  private validationFailure(error: AdmissionFailure): WalAdmissionValidation {
    const rootId = walObjectId(error.root.objectId);
    const related = walObjectId(error.related.objectId);
    const dependencyFailed = !equalBytes(rootId, related) && error.kind === 'quarantined';
    return immutableResult({
      status: error.kind === 'quarantined' && !dependencyFailed ? 'quarantined' : 'blocked',
      reasonCode: error.reasonCode,
      rootObjectId: rootId,
      relatedObjectId: related,
      missingObjectIds: error.missingObjectIds,
      objects: [],
    });
  }

  private async persistFailure(error: AdmissionFailure, cause?: unknown): Promise<WalAdmissionResult> {
    const validation = this.validationFailure(error);
    const related = error.related;
    try {
      if (error.kind === 'quarantined') {
        await this.options.state.quarantineAdmission({
          entryId: related.objectId,
          providerPeerId: related.providerPeerId,
          reasonCode: error.reasonCode,
          byteLength: related.canonicalBytes.length,
          createdAtMs: currentTime(this.now),
          admissionObjectId: related.objectId,
          blockedRootObjectId: equalBytes(related.objectId, error.root.objectId)
            ? null
            : error.root.objectId,
          updatedAtMs: currentTime(this.now),
        });
      } else {
        this.options.state.setAdmissionState(error.root.objectId, 'BLOCKED', error.reasonCode, currentTime(this.now));
      }
      const status: 'blocked' | 'quarantined' = validation.status === 'quarantined'
        ? 'quarantined'
        : 'blocked';
      return immutableResult({ ...validation, status });
    } catch (persistenceError) {
      const reason: WalAdmissionReasonCode = persistenceError instanceof WalControlStoreError
        && persistenceError.code === 'WAL_CONTROL_LIMIT_EXCEEDED'
        ? 'QUARANTINE_LIMIT_EXCEEDED'
        : 'PERSISTENCE_FAILED';
      try {
        this.options.state.setAdmissionState(error.root.objectId, 'BLOCKED', reason, currentTime(this.now));
      } catch {
        // Returning blocked is still fail-closed when the operator store itself is unavailable.
      }
      void cause;
      void persistenceError;
      return immutableResult({
        status: 'blocked', reasonCode: reason,
        rootObjectId: walObjectId(error.root.objectId),
        relatedObjectId: walObjectId(related.objectId),
        missingObjectIds: error.missingObjectIds,
        objects: [],
      });
    }
  }
}
