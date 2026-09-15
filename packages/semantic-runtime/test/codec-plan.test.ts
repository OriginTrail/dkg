import { decode, encode } from 'cborg';
import { describe, expect, it } from 'vitest';

import {
  ABI_VERSION, SCHEMA_VERSION, MESSAGE_TYPE, AbiResponseError,
  decodeAbiSuccess, decodeAdmittedPlan, decodeCompileResult, decodeHandle,
  decodePlanApplyResult, decodeStartedPlanInspection, decodeStartedPlanReceipt,
  decodeStatus, decodeStepOutput,
  encodeAdmitRequest, encodeApplyPlanRequest, encodeCompileRequest,
  encodeCreateRequest, encodeEventRequest, encodeStartPlanRequest,
} from '../src/codec.js';

const id = new Uint8Array(32).fill(0x42);
const bytes = new Uint8Array([1, 2, 3]);
const plan: unknown[] = [bytes, id, 'test/plan', 'network:test', 'inspect', ['read'], ['dkg/query'], ['approval'], { 'dkg/query': 1 }, [1, 2, 3, 4]];
const inspection = [id, 'test/plan', 12, id, [['reader', id, 'waiting']]];
const response = (result: unknown, changes: Record<number, unknown> = {}) => {
  const envelope: unknown[] = [ABI_VERSION, SCHEMA_VERSION, 7, MESSAGE_TYPE.compile, encode(result)];
  for (const [index, value] of Object.entries(changes)) envelope[Number(index)] = value;
  return encode(envelope);
};

describe('semantic plan CBOR contract', () => {
  it('preserves plan authority, resource bounds and adapter versions across admission/compile responses', () => {
    const admitted = decodeAdmittedPlan(encode(plan));
    expect(admitted).toEqual({ canonicalPlan: bytes, canonicalHash: id, strategyRef: 'test/plan', scope: 'network:test', goal: 'inspect', requiredCapabilities: ['read'], effectUpperBound: ['dkg/query'], approvalRequirements: ['approval'], adapterVersions: new Map([['dkg/query', 1]]), resourceBounds: { processes: 1, hostCommands: 2, retryAttempts: 3, depth: 4 } });
    expect(decodeCompileResult(encode([0, encode(plan)]))).toEqual({ ok: true, plan: admitted });
    const diagnostics = encode([['SYNTAX', 1, 2, 3, 4, 'missing form', 'add a form'], ['BOUNDS', 5, 6, 7, 8, 'too large', null]]);
    expect(decodeCompileResult(encode([1, diagnostics]))).toEqual({ ok: false, diagnostics: [
      { code: 'SYNTAX', primary: { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } }, message: 'missing form', help: 'add a form' },
      { code: 'BOUNDS', primary: { start: { line: 5, column: 6 }, end: { line: 7, column: 8 } }, message: 'too large', help: null },
    ] });
  });

  it('retains plan handles, execution identity and agent status in receipts and inspection', () => {
    const expected = { canonicalHash: id, strategyRef: 'test/plan', logicalTime: 12n, stateDigest: id, agents: [{ role: 'reader', processId: id, status: 'waiting' }] };
    expect(decodeStartedPlanInspection(encode(inspection))).toEqual(expected);
    expect(decodeStartedPlanReceipt(encode([42, ...inspection]))).toEqual({ handle: 42, ...expected });
    for (const handle of [0, 0x1_0000_0000]) {
      expect(() => decodeStartedPlanReceipt(encode([handle, ...inspection]))).toThrow(/invalid plan handle/);
    }
    const badStatus = [...inspection.slice(0, 4), [['reader', id, 'unauthorized-state']]];
    expect(() => decodeStartedPlanInspection(encode(badStatus))).toThrow(/unknown logical agent status/);
  });

  it('distinguishes effect suspension from completed output and preserves effect correlation', () => {
    expect(decodePlanApplyResult(encode([0, 99, id, 'dkg/query', 1, ['catalog/items', '{}']]))).toEqual({ kind: 'effect-requested', effectId: 99n, processId: id, operation: 'dkg/query', version: 1, arguments: ['catalog/items', '{}'] });
    expect(decodePlanApplyResult(encode([1, [['reader', id, 'queried']], [['reader', id, 'result']]]))).toEqual({ kind: 'completed', events: [{ role: 'reader', processId: id, value: 'queried' }], outputs: [{ role: 'reader', processId: id, value: 'result' }] });
    expect(() => decodePlanApplyResult(encode([0, 99]))).toThrow(/unknown plan apply result/);
    expect(() => decodePlanApplyResult(encode([2, [], []]))).toThrow(/unknown plan apply result/);
    expect(() => decodeCompileResult(encode([2, bytes]))).toThrow(/unknown compile outcome/);
  });

  it('encodes exact effect acknowledgement and admission wire envelopes', () => {
    expect(decode(encodeCompileRequest(7n, '(emit hello)'))).toEqual([1, 1, 7, MESSAGE_TYPE.compile, new TextEncoder().encode('(emit hello)')]);
    expect(decode(encodeAdmitRequest(7n, bytes))).toEqual([1, 1, 7, MESSAGE_TYPE.admit, bytes]);
    const decodePayload = (input: Uint8Array) => decode((decode(input) as unknown[])[4] as Uint8Array);
    expect(decodePayload(encodeStartPlanRequest(7n, bytes, 12n))).toEqual([bytes, 12]);
    expect(decodePayload(encodeApplyPlanRequest(7n))).toEqual([0]);
    expect(decodePayload(encodeApplyPlanRequest(7n, { effectId: 99n, ok: false, value: 'denied' }))).toEqual([1, 99, false, 'denied']);
    expect(decodePayload(encodeEventRequest(7n, { kind: 'set-deadline', eventId: id, logicalTime: 12n, deadline: null }))).toEqual([1, id, 12, null]);
    expect(decodePayload(encodeEventRequest(7n, { kind: 'set-deadline', eventId: id, logicalTime: 12n, deadline: 20n }))).toEqual([1, id, 12, 20]);
  });

  it('enforces source, plan and runtime bounds before serializing requests', () => {
    expect(() => encodeCompileRequest(1n, 'x'.repeat(1024 * 1024 + 1))).toThrow(/exceeds 1 MiB/);
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    expect(() => encodeAdmitRequest(1n, oversized)).toThrow(/4 MiB/);
    expect(() => encodeStartPlanRequest(1n, oversized, 0n)).toThrow(/4 MiB/);
    expect(() => encodeCreateRequest(1n, { partitionId: id, maxEvents: 0, maxAccumulator: 1n })).toThrow(/maxEvents/);
    expect(() => encodeCreateRequest(1n, { partitionId: id, maxEvents: 1, maxAccumulator: 0n })).toThrow(/maxAccumulator/);
  });

  it('checks ABI versions, correlation, typed payloads and declared failure retryability', () => {
    expect(decodeAbiSuccess(response([0, bytes]), 7n, MESSAGE_TYPE.compile)).toEqual(bytes);
    expect(() => decodeAbiSuccess(response([0, bytes], { 0: 2 }), 7n, MESSAGE_TYPE.compile)).toThrow(/incompatible ABI/);
    expect(() => decodeAbiSuccess(response([0, bytes], { 3: MESSAGE_TYPE.apply }), 7n, MESSAGE_TYPE.compile)).toThrow(/messageType/);
    expect(() => decodeAbiSuccess(response([0, bytes], { 4: 'not bytes' }), 7n, MESSAGE_TYPE.compile)).toThrow(/must be bytes/);
    expect(() => decodeAbiSuccess(response([1, 'DENIED', 'capability', true]), 7n, MESSAGE_TYPE.compile)).toThrow(AbiResponseError);
    try { decodeAbiSuccess(response([1, 'DENIED', 'capability', true]), 7n, MESSAGE_TYPE.compile); }
    catch (error) { expect(error).toMatchObject({ code: 'DENIED', category: 'capability', retryable: true }); }
    expect(() => decodeAbiSuccess(response([1, 'DENIED']), 7n, MESSAGE_TYPE.compile)).toThrow(/malformed ABI error/);
    expect(() => decodeAbiSuccess(response([2, bytes]), 7n, MESSAGE_TYPE.compile)).toThrow(/malformed ABI success/);
  });

  it('rejects malformed scalar/container values rather than coercing them', () => {
    expect(decodeHandle(encode([42]))).toBe(42);
    expect(() => decodeHandle(encode([0]))).toThrow(/invalid handle/);
    expect(() => decodeHandle(encode([-1]))).toThrow(/unsigned integer/);
    expect(() => decodeHandle(encode([2n ** 60n]))).toThrow(/safe integer range/);
    expect(() => decodeHandle(encode({ handle: 1 }))).toThrow(/array/);
    expect(() => decodeStatus(encode(['true']))).toThrow(/boolean/);
    const badGoal = [...plan]; badGoal[4] = 4;
    expect(() => decodeAdmittedPlan(encode(badGoal))).toThrow(/string/);
    const badAdapters = [...plan]; badAdapters[8] = [];
    expect(() => decodeAdmittedPlan(encode(badAdapters))).toThrow(/map/);
    expect(() => decodeStepOutput(encode([0, 0, null, id, [[id, 0, 9, 0]], false]))).toThrow(/unknown trace kind/);
  });
});
