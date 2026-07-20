import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WalAdmissionPipeline,
  WalAdmissionError,
  admissionError,
  type WalAdmissionAdapter,
  type WalAdmissionCandidate,
  type WalAdmissionDeferredDecision,
  type WalAdmissionEvidenceDecision,
  type WalAdmissionPayloadAnalysis,
  type WalAdmissionPayloadInspection,
} from '../../src/admission/index.js';
import { WalControlStore } from '../../src/control/index.js';
import { encodeCanonicalCbor } from '../../src/protocol/canonical-cbor.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import {
  createWalObjectV1,
  type VerifiedWalObjectV1,
} from '../../src/protocol/wal-object.js';
import { hashBytes } from '../../src/reconciliation/hash.js';
import { walObjectId } from '../../src/reconciliation/ids.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';

const roots: string[] = [];
const controls: WalControlStore[] = [];
const stores: PackedWalObjectStore[] = [];

afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function bytes(label: string): Uint8Array {
  return hashBytes(new TextEncoder().encode(`wal-admission-test-v1\0${label}`));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

type TestSigner = WalEip191Signer & { readonly address: Uint8Array };

function signer(slot: number): TestSigner {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  return {
    address: recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey)),
    signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
  };
}

interface ObjectOptions {
  namespaceId?: Uint8Array;
  writerSlot?: number;
  writerEpoch?: bigint;
  sequence?: bigint;
  previousObjectId?: Uint8Array | null;
  payloadBytes?: Uint8Array;
}

async function object(label: string, options: ObjectOptions = {}): Promise<VerifiedWalObjectV1> {
  return createWalObjectV1([
    1n,
    options.namespaceId ?? bytes('namespace'),
    signer(options.writerSlot ?? 1).address,
    options.writerEpoch ?? 0n,
    options.sequence ?? 0n,
    options.previousObjectId ?? null,
    options.payloadBytes ?? new TextEncoder().encode(label),
  ], signer(options.writerSlot ?? 1));
}

function candidate(
  value: VerifiedWalObjectV1,
  options: Partial<WalAdmissionCandidate> = {},
): WalAdmissionCandidate {
  return {
    objectId: options.objectId ?? value.walObjectId,
    canonicalBytes: options.canonicalBytes ?? value.canonicalBytes,
    providerPeerId: options.providerPeerId ?? new TextEncoder().encode('peer-a'),
    ingress: options.ingress ?? 'network',
    visibility: options.visibility ?? 'public',
    checkpointProofBytes: options.checkpointProofBytes,
    closureProofBytes: options.closureProofBytes,
    storageOrigin: options.storageOrigin,
  };
}

function emptyAnalysis(label: string, overrides: Partial<WalAdmissionPayloadAnalysis> = {}): WalAdmissionPayloadAnalysis {
  return {
    adapterVersion: 1,
    logicalKeys: [bytes(`logical:${label}`)],
    parents: [],
    baseHeads: [],
    policyObjectId: null,
    contentObjectIds: [],
    vmEvidenceObjectIds: [],
    carriesChainEvidence: false,
    carriesVmEvidence: false,
    ...overrides,
  };
}

type ScopeDecision = 'accepted' | 'cross-view' | 'invalid';

interface AdapterControls {
  privatePayload: boolean;
  inspectThrows: boolean;
  invalidInspection: boolean;
  privateAllowed: boolean;
  privateThrows: boolean;
  checkpoint: WalAdmissionEvidenceDecision;
  checkpointThrows: boolean;
  namespaceAllowed: boolean;
  namespaceThrows: boolean;
  openThrows: boolean;
  policy: WalAdmissionEvidenceDecision;
  policyThrows: boolean;
  scope: ScopeDecision;
  scopeThrows: boolean;
  crossAuthor: boolean;
  crossAuthorThrows: boolean;
  chain: WalAdmissionDeferredDecision;
  chainThrows: boolean;
  vm: WalAdmissionDeferredDecision;
  vmThrows: boolean;
}

function testAdapter(
  analyses: ReadonlyMap<string, WalAdmissionPayloadAnalysis>,
  events: string[],
  overrides: Partial<AdapterControls> = {},
): WalAdmissionAdapter {
  const controls: AdapterControls = {
    privatePayload: false,
    inspectThrows: false,
    invalidInspection: false,
    privateAllowed: true,
    privateThrows: false,
    checkpoint: 'accepted',
    checkpointThrows: false,
    namespaceAllowed: true,
    namespaceThrows: false,
    openThrows: false,
    policy: 'accepted',
    policyThrows: false,
    scope: 'accepted',
    scopeThrows: false,
    crossAuthor: true,
    crossAuthorThrows: false,
    chain: 'accepted',
    chainThrows: false,
    vm: 'accepted',
    vmThrows: false,
    ...overrides,
  };
  const mark = (objectId: Uint8Array, phase: string): void => {
    events.push(`${hex(objectId).slice(0, 8)}:${phase}`);
  };
  return {
    inspectPayload({ objectId }): WalAdmissionPayloadInspection {
      mark(objectId, 'inspect');
      if (controls.inspectThrows) throw new Error('bad envelope');
      if (controls.invalidInspection) return null as never;
      return { privatePayload: controls.privatePayload, descriptor: Object.freeze({}) };
    },
    authorizePrivate({ objectId }) {
      mark(objectId, 'private-auth');
      if (controls.privateThrows) throw new Error('private authorization failed');
      return controls.privateAllowed;
    },
    verifyCheckpointInclusion({ objectId }) {
      mark(objectId, 'checkpoint');
      if (controls.checkpointThrows) throw new Error('checkpoint failed');
      return controls.checkpoint;
    },
    authorizeNamespace({ objectId }) {
      mark(objectId, 'namespace');
      if (controls.namespaceThrows) throw new Error('namespace failed');
      return controls.namespaceAllowed;
    },
    openPayload({ objectId }) {
      mark(objectId, 'open');
      if (controls.openThrows) throw new Error('bad content');
      const analysis = analyses.get(hex(objectId));
      if (analysis === undefined) throw new Error('missing analysis');
      return analysis;
    },
    validatePolicy({ object }) {
      mark(object.verified.walObjectId, 'policy');
      if (controls.policyThrows) throw new Error('policy failed');
      return controls.policy;
    },
    validateReferenceScopes({ object }) {
      mark(object.verified.walObjectId, 'scope');
      if (controls.scopeThrows) throw new Error('scope failed');
      return controls.scope;
    },
    validateCrossAuthorReferences({ object }) {
      mark(object.verified.walObjectId, 'cross-author');
      if (controls.crossAuthorThrows) throw new Error('cross-author failed');
      return controls.crossAuthor;
    },
    validateChainEvidence({ object }) {
      mark(object.verified.walObjectId, 'chain');
      if (controls.chainThrows) throw new Error('chain failed');
      return controls.chain;
    },
    validateVmEvidence({ object }) {
      mark(object.verified.walObjectId, 'vm');
      if (controls.vmThrows) throw new Error('vm failed');
      return controls.vm;
    },
  };
}

interface Harness {
  root: string;
  store: PackedWalObjectStore;
  control: WalControlStore;
  pipeline: WalAdmissionPipeline;
  analyses: Map<string, WalAdmissionPayloadAnalysis>;
  dependencies: Map<string, WalAdmissionCandidate>;
  events: string[];
}

async function harness(options: {
  adapter?: Partial<AdapterControls>;
  adapterInstance?: WalAdmissionAdapter;
  pipeline?: Partial<ConstructorParameters<typeof WalAdmissionPipeline>[0]>;
  control?: Partial<ConstructorParameters<typeof WalControlStore>[0]>;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dkg-wal-admission-'));
  roots.push(root);
  const store = new PackedWalObjectStore({ root });
  stores.push(store);
  const control = new WalControlStore({ root, now: () => 1_000, ...options.control });
  controls.push(control);
  const analyses = new Map<string, WalAdmissionPayloadAnalysis>();
  const dependencies = new Map<string, WalAdmissionCandidate>();
  const events: string[] = [];
  const pipeline = new WalAdmissionPipeline({
    adapter: options.adapterInstance ?? testAdapter(analyses, events, options.adapter),
    state: control,
    objects: store,
    fetchDependency: async ({ objectId }) => dependencies.get(hex(objectId)) ?? null,
    supportedAdapterVersions: [1],
    now: () => 1_000,
    ...options.pipeline,
  });
  return { root, store, control, pipeline, analyses, dependencies, events };
}

function setAnalysis(target: Harness, value: VerifiedWalObjectV1, analysis: WalAdmissionPayloadAnalysis): void {
  target.analyses.set(hex(value.walObjectId), analysis);
}

function addDependency(target: Harness, value: VerifiedWalObjectV1, options: Partial<WalAdmissionCandidate> = {}): void {
  target.dependencies.set(hex(value.walObjectId), candidate(value, options));
}

function phaseNames(events: readonly string[]): string[] {
  return events.map(value => value.slice(value.indexOf(':') + 1));
}

async function expectReason(
  controls: Partial<AdapterControls>,
  expectedReason: string,
  expectedPhases: readonly string[],
  options: { visibility?: 'public' | 'private'; analysis?: Partial<WalAdmissionPayloadAnalysis> } = {},
): Promise<void> {
  const target = await harness({ adapter: controls });
  const value = await object(`phase-${expectedReason}`);
  setAnalysis(target, value, emptyAnalysis(expectedReason, options.analysis));
  const result = await target.pipeline.validate(candidate(value, {
    visibility: options.visibility ?? 'public',
  }));
  expect(result).toMatchObject({ status: expectedReason.endsWith('_PENDING') || expectedReason.endsWith('_UNAVAILABLE') ? 'blocked' : 'quarantined', reasonCode: expectedReason });
  expect(phaseNames(target.events)).toEqual(expectedPhases);
}

describe('WalAdmissionPipeline configuration and input boundary', () => {
  it('uses typed admission errors, including reason and cause metadata', () => {
    const direct = new WalAdmissionError(
      'WAL_ADMISSION_PERSISTENCE_FAILED',
      'persistence failed',
      'PERSISTENCE_FAILED',
    );
    expect(direct).toMatchObject({
      name: 'WalAdmissionError',
      code: 'WAL_ADMISSION_PERSISTENCE_FAILED',
      reasonCode: 'PERSISTENCE_FAILED',
    });
    const cause = new Error('disk');
    expect(() => admissionError(
      'WAL_ADMISSION_PERSISTENCE_FAILED', 'wrapped', 'PERSISTENCE_FAILED', cause,
    )).toThrowError(expect.objectContaining({ cause }));
  });

  it('rejects every invalid pipeline configuration deterministically', async () => {
    const target = await harness();
    const base: ConstructorParameters<typeof WalAdmissionPipeline>[0] = {
      adapter: testAdapter(target.analyses, target.events),
      state: target.control,
      objects: target.store,
      fetchDependency: async () => null,
      supportedAdapterVersions: [1],
    };
    const invalid: unknown[] = [
      undefined,
      { ...base, adapter: undefined },
      { ...base, state: undefined },
      { ...base, objects: undefined },
      { ...base, fetchDependency: undefined },
      { ...base, supportedAdapterVersions: undefined },
      { ...base, supportedAdapterVersions: [] },
      { ...base, supportedAdapterVersions: [0] },
      { ...base, supportedAdapterVersions: [1.5] },
      { ...base, supportedAdapterVersions: [65_536] },
      { ...base, supportedAdapterVersions: [1, 1] },
      { ...base, maximumObjectBytes: 0 },
      { ...base, maximumClosureObjects: Number.NaN },
      { ...base, maximumClosureBytes: 1_073_741_825 },
      { ...base, maximumClosureDepth: 0 },
      { ...base, maximumReferencesPerObject: 0 },
      { ...base, maximumLogicalKeysPerObject: 0 },
      { ...base, now: 1 },
    ];
    for (const value of invalid) {
      expect(() => new WalAdmissionPipeline(value as never)).toThrowError(expect.objectContaining({
        code: 'WAL_ADMISSION_INVALID_CONFIGURATION',
      }));
    }
  });

  it('rejects malformed candidates and copies valid optional evidence bytes', async () => {
    const target = await harness();
    const value = await object('candidate-boundary');
    setAnalysis(target, value, emptyAnalysis('candidate-boundary'));
    const valid = candidate(value);
    const malformed: unknown[] = [
      null,
      { ...valid, objectId: 'not-bytes' },
      { ...valid, objectId: new Uint8Array(31) },
      { ...valid, canonicalBytes: 'not-bytes' },
      { ...valid, canonicalBytes: new Uint8Array() },
      { ...valid, providerPeerId: 'not-bytes' },
      { ...valid, providerPeerId: new Uint8Array() },
      { ...valid, ingress: 'unknown' },
      { ...valid, visibility: 'unknown' },
      { ...valid, storageOrigin: 'LOCAL' },
      { ...valid, checkpointProofBytes: 'not-bytes' },
      { ...valid, closureProofBytes: 'not-bytes' },
    ];
    for (const input of malformed) {
      await expect(target.pipeline.validate(input as never)).rejects.toMatchObject({
        code: 'WAL_ADMISSION_INVALID_CONFIGURATION',
      });
    }
    const proof = Uint8Array.of(1, 2);
    const closure = Uint8Array.of(3, 4);
    const result = await target.pipeline.validate(candidate(value, {
      checkpointProofBytes: proof,
      closureProofBytes: closure,
      storageOrigin: 'SNAPSHOT',
    }));
    proof[0] = 9;
    closure[0] = 9;
    expect(result.objects[0]!.candidate.checkpointProofBytes).toEqual(Uint8Array.of(1, 2));
    expect(result.objects[0]!.candidate.closureProofBytes).toEqual(Uint8Array.of(3, 4));
    expect((await target.pipeline.validate(candidate(value, {
      checkpointProofBytes: null,
      closureProofBytes: null,
    }))).status).toBe('valid');
  });

  it('rejects malformed adapter analysis without interpreting application content', async () => {
    const target = await harness();
    const value = await object('analysis-boundary');
    const malformed: Array<readonly [unknown, string]> = [
      [null, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('nan'), adapterVersion: Number.NaN }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('negative'), adapterVersion: -1 }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('large'), adapterVersion: 65_536 }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('array'), logicalKeys: null }, 'LOGICAL_KEY_LIMIT_EXCEEDED'],
      [{ ...emptyAnalysis('short-id'), logicalKeys: [Uint8Array.of(1)] }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('duplicate'), logicalKeys: [bytes('same'), bytes('same')] }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('policy-undefined'), policyObjectId: undefined }, 'PAYLOAD_INVALID'],
      [{ ...emptyAnalysis('policy-short'), policyObjectId: Uint8Array.of(1) }, 'PAYLOAD_INVALID'],
    ];
    for (const [analysis, reasonCode] of malformed) {
      target.analyses.set(hex(value.walObjectId), analysis as never);
      const result = await target.pipeline.validate(candidate(value));
      expect(result).toMatchObject({ status: 'quarantined', reasonCode });
    }

    target.analyses.set(hex(value.walObjectId), {
      adapterVersion: 1,
      logicalKeys: [bytes('minimal-logical')],
      parents: [],
      baseHeads: [],
      policyObjectId: null,
      carriesChainEvidence: true,
      carriesVmEvidence: true,
    });
    expect((await target.pipeline.validate(candidate(value))).status).toBe('valid');

    const bounded = await harness({ pipeline: { maximumReferencesPerObject: 1 } });
    const boundedObject = await object('combined-reference-limit');
    setAnalysis(bounded, boundedObject, emptyAnalysis('combined-reference-limit', {
      parents: [bytes('parent-ref')],
      baseHeads: [bytes('base-ref')],
    }));
    expect((await bounded.pipeline.validate(candidate(boundedObject))).reasonCode).toBe('REFERENCE_LIMIT_EXCEEDED');
  });

  it('rejects an invalid clock when durable admission needs a timestamp', async () => {
    for (const time of [-1, 1.5]) {
      const target = await harness({ pipeline: { now: () => time } });
      const value = await object(`invalid-clock-${time}`);
      setAnalysis(target, value, emptyAnalysis(`invalid-clock-${time}`));
      await expect(target.pipeline.admit(candidate(value))).rejects.toMatchObject({
        code: 'WAL_ADMISSION_INVALID_CONFIGURATION',
      });
    }
  });

  it('uses the system clock by default and rethrows unexpected state failures during validation', async () => {
    const target = await harness();
    let value = await object('default-clock');
    setAnalysis(target, value, emptyAnalysis('default-clock'));
    const defaultClock = new WalAdmissionPipeline({
      adapter: testAdapter(target.analyses, target.events),
      state: target.control,
      objects: target.store,
      fetchDependency: async () => null,
      supportedAdapterVersions: [1],
    });
    expect((await defaultClock.admit(candidate(value))).status).toBe('admitted');

    const failedState = new Proxy(target.control, {
      get(control, property) {
        if (property === 'getWalObjectMetadata') return () => { throw new Error('state read failed'); };
        const member = Reflect.get(control, property, control) as unknown;
        return typeof member === 'function' ? member.bind(control) : member;
      },
    });
    value = await object('unexpected-state-failure', { writerSlot: 2 });
    setAnalysis(target, value, emptyAnalysis('unexpected-state-failure'));
    const failed = new WalAdmissionPipeline({
      adapter: testAdapter(target.analyses, target.events),
      state: failedState,
      objects: target.store,
      fetchDependency: async () => null,
      supportedAdapterVersions: [1],
    });
    await expect(failed.validate(candidate(value))).rejects.toThrow('state read failed');
  });
});

describe('WalAdmissionPipeline validation order', () => {
  it('validates public bytes in the documented fail-closed order', async () => {
    const target = await harness();
    const value = await object('ordered-public');
    setAnalysis(target, value, emptyAnalysis('ordered-public'));
    const result = await target.pipeline.validate(candidate(value));
    expect(result).toMatchObject({ status: 'valid', reasonCode: null });
    expect(phaseNames(target.events)).toEqual([
      'inspect', 'checkpoint', 'namespace', 'open',
      'policy', 'scope', 'cross-author', 'chain', 'vm',
    ]);
  });

  it('authorizes private membership before opening or disclosing private content', async () => {
    const target = await harness({ adapter: { privatePayload: true, privateAllowed: false } });
    const value = await object('ordered-private');
    setAnalysis(target, value, emptyAnalysis('ordered-private'));
    const result = await target.pipeline.validate(candidate(value, { visibility: 'private' }));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'PRIVATE_UNAUTHORIZED' });
    expect(phaseNames(target.events)).toEqual(['inspect', 'private-auth']);
    expect(target.events.some(event => event.endsWith(':open'))).toBe(false);
  });

  it('stops at each adapter-controlled validation boundary with a stable reason', async () => {
    await expectReason({ inspectThrows: true }, 'PAYLOAD_ENVELOPE_INVALID', ['inspect']);
    await expectReason({ checkpoint: 'missing' }, 'CHECKPOINT_UNAVAILABLE', ['inspect', 'checkpoint']);
    await expectReason({ checkpoint: 'invalid' }, 'CHECKPOINT_INVALID', ['inspect', 'checkpoint']);
    await expectReason({ namespaceAllowed: false }, 'NAMESPACE_UNAUTHORIZED', ['inspect', 'checkpoint', 'namespace']);
    await expectReason({ openThrows: true }, 'PAYLOAD_INVALID', ['inspect', 'checkpoint', 'namespace', 'open']);
    await expectReason({}, 'ADAPTER_VERSION_UNSUPPORTED', ['inspect', 'checkpoint', 'namespace', 'open'], {
      analysis: { adapterVersion: 2 },
    });
    await expectReason({ policy: 'missing' }, 'POLICY_UNAVAILABLE', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy',
    ]);
    await expectReason({ policy: 'invalid' }, 'POLICY_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy',
    ]);
    await expectReason({ scope: 'cross-view' }, 'CROSS_VIEW_REFERENCE', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope',
    ]);
    await expectReason({ scope: 'invalid' }, 'CAUSAL_LINK_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope',
    ]);
    await expectReason({ crossAuthor: false }, 'CROSS_AUTHOR_UNAUTHORIZED', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author',
    ]);
    await expectReason({ chain: 'pending' }, 'CHAIN_EVIDENCE_PENDING', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain',
    ]);
    await expectReason({ chain: 'invalid' }, 'CHAIN_EVIDENCE_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain',
    ]);
    await expectReason({ vm: 'pending' }, 'VM_EVIDENCE_PENDING', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain', 'vm',
    ]);
    await expectReason({ vm: 'invalid' }, 'VM_EVIDENCE_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain', 'vm',
    ]);
  });

  it('maps every adapter exception and malformed inspection to the same fail-closed reason', async () => {
    await expectReason({ invalidInspection: true }, 'PAYLOAD_ENVELOPE_INVALID', ['inspect']);
    await expectReason({ privatePayload: true, privateThrows: true }, 'PRIVATE_UNAUTHORIZED', ['inspect', 'private-auth'], {
      visibility: 'private',
    });
    await expectReason({ checkpointThrows: true }, 'CHECKPOINT_INVALID', ['inspect', 'checkpoint']);
    await expectReason({ namespaceThrows: true }, 'NAMESPACE_UNAUTHORIZED', ['inspect', 'checkpoint', 'namespace']);
    await expectReason({ policyThrows: true }, 'POLICY_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy',
    ]);
    await expectReason({ scopeThrows: true }, 'CAUSAL_LINK_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope',
    ]);
    await expectReason({ crossAuthorThrows: true }, 'CROSS_AUTHOR_UNAUTHORIZED', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author',
    ]);
    await expectReason({ chainThrows: true }, 'CHAIN_EVIDENCE_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain',
    ]);
    await expectReason({ vmThrows: true }, 'VM_EVIDENCE_INVALID', [
      'inspect', 'checkpoint', 'namespace', 'open', 'policy', 'scope', 'cross-author', 'chain', 'vm',
    ]);
  });

  it('classifies object, identity, lane, visibility, and private-open failures before semantics', async () => {
    let target = await harness();
    let value = await object('invalid-canonical');
    const corrupt = new Uint8Array(value.canonicalBytes);
    corrupt[corrupt.length - 1] ^= 1;
    let result = await target.pipeline.validate(candidate(value, { canonicalBytes: corrupt }));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'INVALID_WAL_OBJECT' });
    expect(target.events).toEqual([]);

    target = await harness();
    value = await object('wrong-id');
    result = await target.pipeline.validate(candidate(value, { objectId: bytes('wrong-id') }));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'WAL_OBJECT_ID_MISMATCH' });
    expect(target.events).toEqual([]);

    target = await harness();
    value = await object('wrong-lane-link');
    const malformedLaneBytes = encodeCanonicalCbor([
      value.tuple[0], value.tuple[1], value.tuple[2], value.tuple[3], 1n, null,
      value.tuple[6], value.tuple[7],
    ]);
    result = await target.pipeline.validate({
      ...candidate(value),
      canonicalBytes: malformedLaneBytes,
      objectId: bytes('malformed-lane-object-id'),
    });
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'INVALID_LANE_LINK' });
    expect(target.events).toEqual([]);

    target = await harness();
    value = await object('visibility-mismatch');
    setAnalysis(target, value, emptyAnalysis('visibility-mismatch'));
    result = await target.pipeline.validate(candidate(value, { visibility: 'private' }));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'PRIVATE_PAYLOAD_INVALID' });
    expect(phaseNames(target.events)).toEqual(['inspect']);

    target = await harness({ adapter: { privatePayload: true, openThrows: true } });
    value = await object('bad-private-open');
    setAnalysis(target, value, emptyAnalysis('bad-private-open'));
    result = await target.pipeline.validate(candidate(value, { visibility: 'private' }));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'PRIVATE_PAYLOAD_INVALID' });
    expect(phaseNames(target.events)).toEqual(['inspect', 'private-auth', 'checkpoint', 'namespace', 'open']);
  });
});

describe('WalAdmissionPipeline closure and atomic admission', () => {
  it('reserves local commit for WAL-013 and blocks a pre-aborted validation without touching storage', async () => {
    const target = await harness();
    const value = await object('local-and-abort');
    setAnalysis(target, value, emptyAnalysis('local-and-abort'));
    await expect(target.pipeline.admit(candidate(value, { ingress: 'local' }))).rejects.toMatchObject({
      code: 'WAL_ADMISSION_INVALID_CONFIGURATION',
    });
    const controller = new AbortController();
    controller.abort();
    const result = await target.pipeline.validate(candidate(value), { signal: controller.signal });
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(await target.store.has(walObjectId(value.walObjectId))).toBe(false);
  });

  it('fetches a complete parent/policy/content closure and atomically queues every logical key', async () => {
    const target = await harness();
    const parent = await object('parent', { writerSlot: 1 });
    const policy = await object('policy', { writerSlot: 2 });
    const content = await object('content', { writerSlot: 3 });
    const root = await object('root', {
      writerSlot: 1,
      sequence: 1n,
      previousObjectId: parent.walObjectId,
    });
    setAnalysis(target, parent, emptyAnalysis('parent'));
    setAnalysis(target, policy, emptyAnalysis('policy'));
    setAnalysis(target, content, emptyAnalysis('content'));
    setAnalysis(target, root, emptyAnalysis('root', {
      parents: [parent.walObjectId],
      policyObjectId: policy.walObjectId,
      contentObjectIds: [content.walObjectId],
    }));
    for (const dependency of [parent, policy, content]) addDependency(target, dependency);

    const result = await target.pipeline.admit(candidate(root));
    expect(result).toMatchObject({ status: 'admitted', reasonCode: null });
    expect(result.objects).toHaveLength(4);
    for (const value of [root, parent, policy, content]) {
      expect(target.control.getAdmission(value.walObjectId)?.state).toBe('ADMITTED');
      expect(target.control.getWalObjectMetadata(value.walObjectId)?.objectId).toEqual(value.walObjectId);
      expect(await target.store.has(walObjectId(value.walObjectId))).toBe(true);
    }
    const leased = [];
    for (;;) {
      const entry = target.control.leaseRetry(1_000, 1_000);
      if (entry === null) break;
      leased.push(entry);
      target.control.completeRetry(entry.key);
    }
    expect(leased).toHaveLength(4);
    expect(leased.every(entry => entry.kind === 'WAL_REDUCE_LOGICAL_KEY')).toBe(true);
    expect((await target.pipeline.admit(candidate(root))).status).toBe('already-admitted');
  });

  it('blocks an incomplete closure, then restages and admits it when the missing object arrives', async () => {
    const target = await harness();
    const dependency = await object('late-dependency', { writerSlot: 2 });
    const root = await object('late-root', { writerSlot: 1 });
    setAnalysis(target, dependency, emptyAnalysis('late-dependency'));
    setAnalysis(target, root, emptyAnalysis('late-root', { contentObjectIds: [dependency.walObjectId] }));

    let result = await target.pipeline.admit(candidate(root));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(result.missingObjectIds).toEqual([dependency.walObjectId]);
    expect(target.control.getAdmission(root.walObjectId)?.state).toBe('BLOCKED');
    expect(target.control.getWalObjectMetadata(root.walObjectId)).toBeNull();
    expect(await target.store.has(walObjectId(root.walObjectId))).toBe(false);

    addDependency(target, dependency);
    result = await target.pipeline.admit(candidate(root));
    expect(result.status).toBe('admitted');
    expect(target.control.getAdmission(root.walObjectId)?.state).toBe('ADMITTED');
    expect(target.control.getAdmission(dependency.walObjectId)?.state).toBe('ADMITTED');
  });

  it('reports multiple missing dependencies in deterministic object-ID order', async () => {
    const target = await harness();
    const root = await object('multiple-missing');
    const missing = [bytes('missing-z'), bytes('missing-a')];
    setAnalysis(target, root, emptyAnalysis('multiple-missing', { contentObjectIds: missing }));
    const result = await target.pipeline.validate(candidate(root));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(result.missingObjectIds).toEqual([...missing].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
  });

  it('treats dependency-fetch exceptions as missing and accepts an already-admitted parent without refetching it', async () => {
    let fetches = 0;
    let target = await harness({
      pipeline: {
        fetchDependency: async () => {
          fetches += 1;
          throw new Error('provider unavailable');
        },
      },
    });
    let dependency = await object('fetch-error-dependency', { writerSlot: 2 });
    let root = await object('fetch-error-root', { writerSlot: 1 });
    setAnalysis(target, root, emptyAnalysis('fetch-error-root', { contentObjectIds: [dependency.walObjectId] }));
    let result = await target.pipeline.validate(candidate(root));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(fetches).toBe(1);

    target = await harness();
    dependency = await object('admitted-parent', { writerSlot: 1 });
    setAnalysis(target, dependency, emptyAnalysis('admitted-parent'));
    expect((await target.pipeline.admit(candidate(dependency))).status).toBe('admitted');
    root = await object('child-of-admitted-parent', {
      writerSlot: 1,
      sequence: 1n,
      previousObjectId: dependency.walObjectId,
    });
    setAnalysis(target, root, emptyAnalysis('child-of-admitted-parent', { parents: [dependency.walObjectId] }));
    const admitted = await target.pipeline.admit(candidate(root, { ingress: 'backfill' }));
    expect(admitted.status).toBe('admitted');
    expect(admitted.objects).toHaveLength(1);
    expect(target.control.getWalObjectMetadata(root.walObjectId)?.origin).toBe('GENESIS');
  });

  it('classifies a malformed dependency response as dependency invalid', async () => {
    const dependencyId = bytes('malformed-dependency-id');
    const target = await harness({
      pipeline: {
        fetchDependency: async () => ({ objectId: new Uint8Array() }) as never,
      },
    });
    const root = await object('malformed-dependency-root');
    setAnalysis(target, root, emptyAnalysis('malformed-dependency-root', { contentObjectIds: [dependencyId] }));
    const result = await target.pipeline.validate(candidate(root));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'DEPENDENCY_INVALID' });
  });

  it('accepts an explicit snapshot origin and detects equivocation against an admitted author position', async () => {
    const target = await harness();
    const first = await object('admitted-position');
    setAnalysis(target, first, emptyAnalysis('admitted-position'));
    expect((await target.pipeline.admit(candidate(first, { storageOrigin: 'SNAPSHOT' }))).status).toBe('admitted');
    expect(target.control.getWalObjectMetadata(first.walObjectId)?.origin).toBe('SNAPSHOT');

    const conflict = await object('conflicting-position');
    setAnalysis(target, conflict, emptyAnalysis('conflicting-position'));
    const result = await target.pipeline.validate(candidate(conflict));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'AUTHOR_EQUIVOCATION' });
    expect((await target.pipeline.validate(candidate(first))).objects).toHaveLength(0);
  });

  it('walks a shared-dependency DAG once and preserves all dependency roles', async () => {
    const target = await harness();
    const leaf = await object('shared-leaf', { writerSlot: 4 });
    const left = await object('shared-left', { writerSlot: 2 });
    const right = await object('shared-right', { writerSlot: 3 });
    const root = await object('shared-root', { writerSlot: 1 });
    setAnalysis(target, leaf, emptyAnalysis('shared-leaf'));
    setAnalysis(target, left, emptyAnalysis('shared-left', { contentObjectIds: [leaf.walObjectId] }));
    setAnalysis(target, right, emptyAnalysis('shared-right', { vmEvidenceObjectIds: [leaf.walObjectId] }));
    setAnalysis(target, root, emptyAnalysis('shared-root', {
      baseHeads: [left.walObjectId],
      contentObjectIds: [right.walObjectId],
    }));
    for (const value of [leaf, left, right]) addDependency(target, value);
    const result = await target.pipeline.validate(candidate(root));
    expect(result.status).toBe('valid');
    expect(result.objects).toHaveLength(4);
    expect(target.events.filter(event => event.endsWith(':inspect'))).toHaveLength(4);
  });

  it('enforces the combined previous-link plus adapter-reference bound', async () => {
    const target = await harness({ pipeline: { maximumReferencesPerObject: 1 } });
    const parent = await object('reference-parent', { writerSlot: 1 });
    const other = await object('reference-other', { writerSlot: 2 });
    const root = await object('reference-root', {
      writerSlot: 1,
      sequence: 1n,
      previousObjectId: parent.walObjectId,
    });
    setAnalysis(target, root, emptyAnalysis('reference-root', { baseHeads: [other.walObjectId] }));
    const result = await target.pipeline.validate(candidate(root));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'REFERENCE_LIMIT_EXCEEDED' });
  });

  it('rejects causal cycles, lane-link substitution, author equivocation, and wrong fetched identity', async () => {
    let target = await harness();
    let left = await object('cycle-left', { writerSlot: 1 });
    let right = await object('cycle-right', { writerSlot: 2 });
    setAnalysis(target, left, emptyAnalysis('cycle-left', { contentObjectIds: [right.walObjectId] }));
    setAnalysis(target, right, emptyAnalysis('cycle-right', { contentObjectIds: [left.walObjectId] }));
    addDependency(target, right);
    addDependency(target, left);
    let result = await target.pipeline.validate(candidate(left));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'CAUSAL_CYCLE' });

    target = await harness();
    const wrongParent = await object('wrong-parent', { writerSlot: 2 });
    const child = await object('child', { writerSlot: 1, sequence: 1n, previousObjectId: wrongParent.walObjectId });
    setAnalysis(target, wrongParent, emptyAnalysis('wrong-parent'));
    setAnalysis(target, child, emptyAnalysis('child'));
    addDependency(target, wrongParent);
    result = await target.pipeline.validate(candidate(child));
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'CAUSAL_LINK_INVALID' });

    target = await harness();
    left = await object('equivocation-left', { writerSlot: 1 });
    right = await object('equivocation-right', { writerSlot: 1 });
    const collector = await object('equivocation-root', { writerSlot: 2 });
    setAnalysis(target, left, emptyAnalysis('equivocation-left'));
    setAnalysis(target, right, emptyAnalysis('equivocation-right'));
    setAnalysis(target, collector, emptyAnalysis('equivocation-root', {
      contentObjectIds: [left.walObjectId, right.walObjectId],
    }));
    addDependency(target, left);
    addDependency(target, right);
    result = await target.pipeline.validate(candidate(collector));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'AUTHOR_EQUIVOCATION' });

    target = await harness();
    const expected = await object('expected', { writerSlot: 2 });
    const substituted = await object('substituted', { writerSlot: 3 });
    const requester = await object('requester', { writerSlot: 1 });
    setAnalysis(target, requester, emptyAnalysis('requester', { contentObjectIds: [expected.walObjectId] }));
    target.dependencies.set(hex(expected.walObjectId), candidate(substituted));
    result = await target.pipeline.validate(candidate(requester));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'DEPENDENCY_INVALID' });
    expect(result.relatedObjectId).toEqual(substituted.walObjectId);
  });

  it('enforces closure object, byte, depth, reference, logical-key, and single-object bounds', async () => {
    const cases: Array<{
      name: string;
      configure: (root: VerifiedWalObjectV1, dependency: VerifiedWalObjectV1) => WalAdmissionPayloadAnalysis;
      pipeline: Partial<ConstructorParameters<typeof WalAdmissionPipeline>[0]>;
      expected: string;
      addDependency?: boolean;
    }> = [
      {
        name: 'objects',
        configure: (_root, dependency) => emptyAnalysis('objects', { contentObjectIds: [dependency.walObjectId] }),
        pipeline: { maximumClosureObjects: 1 }, expected: 'CLOSURE_OBJECT_LIMIT_EXCEEDED', addDependency: true,
      },
      {
        name: 'bytes',
        configure: () => emptyAnalysis('bytes'),
        pipeline: { maximumClosureBytes: 1 }, expected: 'CLOSURE_BYTE_LIMIT_EXCEEDED',
      },
      {
        name: 'depth',
        configure: (_root, dependency) => emptyAnalysis('depth', { contentObjectIds: [dependency.walObjectId] }),
        pipeline: { maximumClosureDepth: 1 }, expected: 'CLOSURE_DEPTH_EXCEEDED', addDependency: true,
      },
      {
        name: 'references',
        configure: (_root, dependency) => emptyAnalysis('references', {
          parents: [dependency.walObjectId], baseHeads: [bytes('another-ref')],
        }),
        pipeline: { maximumReferencesPerObject: 1 }, expected: 'REFERENCE_LIMIT_EXCEEDED',
      },
      {
        name: 'logical',
        configure: () => emptyAnalysis('logical', { logicalKeys: [bytes('key-a'), bytes('key-b')] }),
        pipeline: { maximumLogicalKeysPerObject: 1 }, expected: 'LOGICAL_KEY_LIMIT_EXCEEDED',
      },
      {
        name: 'object-bytes',
        configure: () => emptyAnalysis('object-bytes'),
        pipeline: { maximumObjectBytes: 1 }, expected: 'CLOSURE_BYTE_LIMIT_EXCEEDED',
      },
    ];
    for (const testCase of cases) {
      const target = await harness({ pipeline: testCase.pipeline });
      const dependency = await object(`${testCase.name}-dependency`, { writerSlot: 2 });
      const root = await object(`${testCase.name}-root`, { writerSlot: 1 });
      setAnalysis(target, root, testCase.configure(root, dependency));
      setAnalysis(target, dependency, emptyAnalysis(`${testCase.name}-dependency`));
      if (testCase.addDependency) addDependency(target, dependency);
      if (testCase.name === 'depth') {
        const leaf = await object('depth-leaf', { writerSlot: 3 });
        setAnalysis(target, dependency, emptyAnalysis('depth-dependency', { contentObjectIds: [leaf.walObjectId] }));
        setAnalysis(target, leaf, emptyAnalysis('depth-leaf'));
        addDependency(target, leaf);
      }
      const result = await target.pipeline.validate(candidate(root));
      expect(result.reasonCode, testCase.name).toBe(testCase.expected);
    }
  });
});

describe('WalAdmissionPipeline quarantine and ingress parity', () => {
  it('keeps WAL metadata blocked when physical or control persistence fails, then permits retry', async () => {
    const target = await harness();
    const value = await object('persistence-retry');
    setAnalysis(target, value, emptyAnalysis('persistence-retry'));
    const failing = new WalAdmissionPipeline({
      adapter: testAdapter(target.analyses, target.events),
      state: target.control,
      objects: {
        has: id => target.store.has(id),
        put: async () => { throw new Error('disk unavailable'); },
      },
      fetchDependency: async () => null,
      supportedAdapterVersions: [1],
      now: () => 1_000,
    });
    let result = await failing.admit(candidate(value));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'PERSISTENCE_FAILED' });
    expect(target.control.getAdmission(value.walObjectId)?.state).toBe('BLOCKED');
    expect(target.control.getWalObjectMetadata(value.walObjectId)).toBeNull();
    expect(await target.store.has(walObjectId(value.walObjectId))).toBe(false);
    result = await target.pipeline.admit(candidate(value));
    expect(result.status).toBe('admitted');
  });

  it('maps quarantine quota exhaustion separately from a failed control store', async () => {
    let target = await harness({
      control: { maximumQuarantineBytesPerPeer: 1 },
      pipeline: { supportedAdapterVersions: [1] },
    });
    let value = await object('quarantine-quota');
    setAnalysis(target, value, emptyAnalysis('quarantine-quota', { adapterVersion: 2 }));
    let result = await target.pipeline.admit(candidate(value));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'QUARANTINE_LIMIT_EXCEEDED' });
    expect(target.control.getAdmission(value.walObjectId)?.state).toBe('BLOCKED');
    expect(target.control.getQuarantine(value.walObjectId)).toBeNull();

    target = await harness();
    value = await object('quarantine-store-failure');
    setAnalysis(target, value, emptyAnalysis('quarantine-store-failure', { adapterVersion: 2 }));
    const state = new Proxy(target.control, {
      get(control, property) {
        if (property === 'quarantineAdmission') return async () => { throw new Error('control unavailable'); };
        if (property === 'setAdmissionState') return () => { throw new Error('control unavailable'); };
        const member = Reflect.get(control, property, control) as unknown;
        return typeof member === 'function' ? member.bind(control) : member;
      },
    });
    const pipeline = new WalAdmissionPipeline({
      adapter: testAdapter(target.analyses, target.events),
      state,
      objects: target.store,
      fetchDependency: async () => null,
      supportedAdapterVersions: [1],
      now: () => 1_000,
    });
    result = await pipeline.admit(candidate(value));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'PERSISTENCE_FAILED' });
    expect(target.control.getAdmission(value.walObjectId)?.state).toBe('STAGED');
  });

  it('atomically quarantines an invalid dependency while leaving its root blocked', async () => {
    const target = await harness();
    const dependency = await object('invalid-admission-dependency', { writerSlot: 2 });
    const root = await object('invalid-admission-root', { writerSlot: 1 });
    setAnalysis(target, dependency, emptyAnalysis('invalid-admission-dependency', { adapterVersion: 2 }));
    setAnalysis(target, root, emptyAnalysis('invalid-admission-root', { contentObjectIds: [dependency.walObjectId] }));
    addDependency(target, dependency);
    const result = await target.pipeline.admit(candidate(root));
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'ADAPTER_VERSION_UNSUPPORTED' });
    expect(target.control.getAdmission(dependency.walObjectId)).toEqual(expect.objectContaining({
      state: 'QUARANTINED', reasonCode: 'ADAPTER_VERSION_UNSUPPORTED',
    }));
    expect(target.control.getAdmission(root.walObjectId)).toEqual(expect.objectContaining({
      state: 'BLOCKED', reasonCode: 'DEPENDENCY_INVALID',
    }));
    expect(target.control.getQuarantine(dependency.walObjectId)).not.toBeNull();
    expect(target.control.getQuarantine(root.walObjectId)).toBeNull();
  });

  it('persists bounded quarantine provenance and returns the stable reason on replay and restart', async () => {
    const target = await harness({ pipeline: { supportedAdapterVersions: [1] } });
    const value = await object('quarantine');
    setAnalysis(target, value, emptyAnalysis('quarantine', { adapterVersion: 2 }));
    const input = candidate(value);
    let result = await target.pipeline.admit(input);
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'ADAPTER_VERSION_UNSUPPORTED' });
    expect(target.control.getAdmission(value.walObjectId)).toMatchObject({
      state: 'QUARANTINED', reasonCode: 'ADAPTER_VERSION_UNSUPPORTED',
    });
    expect(target.control.getQuarantine(value.walObjectId)).toMatchObject({
      reasonCode: 'ADAPTER_VERSION_UNSUPPORTED', byteLength: value.canonicalBytes.length,
    });
    expect(await target.store.has(walObjectId(value.walObjectId))).toBe(false);
    result = await target.pipeline.admit(input);
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'ADAPTER_VERSION_UNSUPPORTED' });

    target.control.close();
    controls.splice(controls.indexOf(target.control), 1);
    target.store.close();
    stores.splice(stores.indexOf(target.store), 1);
    const store = new PackedWalObjectStore({ root: target.root });
    stores.push(store);
    const control = new WalControlStore({ root: target.root, now: () => 1_001 });
    controls.push(control);
    expect(control.getAdmission(value.walObjectId)?.state).toBe('QUARANTINED');
    expect(control.listQuarantine()).toHaveLength(1);
  });

  it('does not let quarantine overwrite an admitted canonical object', async () => {
    const target = await harness();
    const value = await object('canonical-wins');
    setAnalysis(target, value, emptyAnalysis('canonical-wins'));
    expect((await target.pipeline.admit(candidate(value))).status).toBe('admitted');
    expect(() => target.control.quarantine({
      entryId: value.walObjectId,
      providerPeerId: new TextEncoder().encode('peer-a'),
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: value.canonicalBytes.length,
      createdAtMs: 1_001,
    })).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_LANE_CONFLICT' }));
    expect(target.control.getQuarantine(value.walObjectId)).toBeNull();
    expect(target.control.getAdmission(value.walObjectId)?.state).toBe('ADMITTED');
    expect(target.control.getWalObjectMetadata(value.walObjectId)).not.toBeNull();
  });

  it('produces the same validation result for local, network, backfill, and replay ingress', async () => {
    const target = await harness({ adapter: { vm: 'invalid' } });
    const value = await object('ingress-parity');
    setAnalysis(target, value, emptyAnalysis('ingress-parity'));
    const outcomes = [];
    for (const ingress of ['local', 'network', 'backfill', 'replay'] as const) {
      outcomes.push(await target.pipeline.validate(candidate(value, { ingress })));
    }
    expect(outcomes.map(result => [result.status, result.reasonCode])).toEqual([
      ['quarantined', 'VM_EVIDENCE_INVALID'],
      ['quarantined', 'VM_EVIDENCE_INVALID'],
      ['quarantined', 'VM_EVIDENCE_INVALID'],
      ['quarantined', 'VM_EVIDENCE_INVALID'],
    ]);
  });
});
