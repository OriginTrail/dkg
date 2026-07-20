import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeProtocolTuple,
  encodeProtocolTuple,
  unsignedProtocolTuple,
  validateProtocolFieldValue,
  validateProtocolTuple,
  validateUnsignedProtocolTuple,
} from '../../src/protocol/codec.js';
import {
  PROTOCOL_TUPLES,
  WAL_V1_ENUMS,
  WAL_V1_DOMAINS,
  type CborProtocolValue,
  type ProtocolTupleSchema,
  type ProtocolTupleName,
  type WalV1EnumName,
} from '../../src/protocol/schema.js';

function sampleField(type: string): CborProtocolValue {
  if (type.endsWith('|null')) return null;
  const collection = /^(?:sorted-unique|strictly-sorted-unique|array)<(.+)>$/.exec(type);
  if (collection) return [];
  if (type === 'literal-1') return 1n;
  if (type === 'literal-0') return 0n;
  if (type === 'true') return true;
  if (type === 'bool') return false;
  if (type === 'i64') return -1n;
  if (/^(?:u8|u16|u32|u64)(?:-enum)?$/.test(type)) return 0n;
  if (type === 'bstr') return new Uint8Array();
  if (type === 'address20') return new Uint8Array(20);
  if (type === 'signature65') return new Uint8Array(65);
  if (/^bytes\d+$/.test(type)) return new Uint8Array(Number(type.slice(5)));
  if (type === 'nfc-tstr') return 'sample';
  if (type === 'tuple') return [];
  if (type in PROTOCOL_TUPLES) return sampleTuple(type as ProtocolTupleName);
  throw new Error(`test sample does not understand ${type}`);
}

function sampleTuple(name: ProtocolTupleName): CborProtocolValue[] {
  return PROTOCOL_TUPLES[name].fieldTypes.map(sampleField);
}

function byte(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('frozen protocol tuple registry', () => {
  it('matches every WAL-001 named tuple, field order, type, and hash domain', async () => {
    const frozen = JSON.parse(await readFile(
      resolve(process.cwd(), '../../conformance/wal-v1/vectors/protocol-v1.schema.json'),
      'utf8',
    ));
    expect(Object.keys(PROTOCOL_TUPLES)).toEqual(Object.keys(frozen.tuples));
    expect(WAL_V1_DOMAINS).toEqual(frozen.domains);
    expect(WAL_V1_ENUMS).toEqual(frozen.enums);
    for (const [name, schema] of Object.entries(PROTOCOL_TUPLES)) {
      const runtimeSchema: ProtocolTupleSchema = schema;
      expect(schema.fields, `${name} fields`).toEqual(frozen.tuples[name].fields);
      expect(schema.fieldTypes, `${name} field types`).toEqual(frozen.tuples[name].fieldTypes);
      if (runtimeSchema.signed) {
        expect(runtimeSchema.identityDomain, `${name} identity domain`).toBe(frozen.tuples[name].identityDomain);
        expect(runtimeSchema.signatureDomain, `${name} signature domain`).toBe(frozen.tuples[name].signatureDomain);
      }
    }
    expect(PROTOCOL_TUPLES.WalObjectV1.fields).toEqual([
      'version',
      'namespaceId',
      'writerId',
      'writerEpoch',
      'sequence',
      'previousObjectIdOrNull',
      'payloadBytes',
      'signature',
    ]);
    expect(Object.isFrozen(PROTOCOL_TUPLES.WalObjectV1.fields)).toBe(true);
    expect(Object.isFrozen(PROTOCOL_TUPLES.WalObjectV1.fieldTypes)).toBe(true);
    expect(Object.isFrozen(PROTOCOL_TUPLES.AuthoritySetV1.enumFields)).toBe(true);
  });

  it('round-trips one exact-arity typed value for every frozen tuple', () => {
    for (const name of Object.keys(PROTOCOL_TUPLES) as ProtocolTupleName[]) {
      const sample = sampleTuple(name);
      validateProtocolTuple(name, sample);
      const encoded = encodeProtocolTuple(name, sample as never);
      expect(decodeProtocolTuple(name, encoded), name).toEqual(sample);
    }
  });

  it('validates non-null optional, array, sorted-set, strict-set, and named tuple members', () => {
    validateProtocolFieldValue('u64|null', 1n);
    validateProtocolFieldValue('array<u8>', [1n, 2n]);
    validateProtocolFieldValue('sorted-unique<u16>', [1n, 2n]);
    validateProtocolFieldValue('strictly-sorted-unique<bytes32>', [byte(0), byte(1)]);
    validateProtocolFieldValue('WriterCheckpointV1', [byte(0, 20), byte(1)]);

    expect(() => validateProtocolFieldValue('array<u8>', 1n)).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_FIELD_TYPE' }),
    );
    expect(() => validateProtocolFieldValue('sorted-unique<u8>', [1n, 1n])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SET_DUPLICATE' }),
    );
    expect(() => validateProtocolFieldValue('sorted-unique<u8>', [2n, 1n])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SET_ORDER' }),
    );
    expect(() => validateProtocolFieldValue('not-a-frozen-type', 0n)).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_FIELD_TYPE' }),
    );
    expect(() => validateProtocolFieldValue('__proto__', [])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_FIELD_TYPE' }),
    );
  });

  it('accepts every frozen enum value and rejects values outside each named enum', () => {
    for (const [name, schema] of Object.entries(PROTOCOL_TUPLES) as Array<
      [ProtocolTupleName, (typeof PROTOCOL_TUPLES)[ProtocolTupleName]]
    >) {
      const runtimeSchema: ProtocolTupleSchema = schema;
      for (const [fieldIndexText, enumName] of Object.entries(runtimeSchema.enumFields ?? {}) as Array<
        [string, WalV1EnumName]
      >) {
        const fieldIndex = Number(fieldIndexText);
        const allowed = Object.values(WAL_V1_ENUMS[enumName]);
        for (const value of allowed) {
          const sample = sampleTuple(name);
          sample[fieldIndex] = BigInt(value);
          expect(() => validateProtocolTuple(name, sample), `${name}.${schema.fields[fieldIndex]}=${value}`).not.toThrow();
        }
        const sample = sampleTuple(name);
        sample[fieldIndex] = BigInt(Math.max(...allowed) + 1);
        expect(() => validateProtocolTuple(name, sample)).toThrow(
          expect.objectContaining({ code: 'WAL_SCHEMA_ENUM_VALUE' }),
        );
      }
    }
  });

  it.each([
    ['literal-1', 0n],
    ['literal-0', 1n],
    ['true', false],
    ['bool', 0n],
    ['u8', 256n],
    ['u8-enum', -1n],
    ['u16', 65_536n],
    ['u16-enum', -1n],
    ['u32', 4_294_967_296n],
    ['u64', -1n],
    ['i64', 9_223_372_036_854_775_808n],
    ['bstr', 'bytes'],
    ['address20', new Uint8Array(19)],
    ['signature65', new Uint8Array(64)],
    ['bytes12', new Uint8Array(13)],
    ['nfc-tstr', 'e\u0301'],
    ['tuple', 1n],
    ['WriterCheckpointV1', []],
  ])('rejects invalid %s values', (type, value) => {
    expect(() => validateProtocolFieldValue(type, value as CborProtocolValue)).toThrow();
  });

  it('accepts every fixed integer boundary and rejects the lower i64 boundary overflow', () => {
    for (const [type, values] of [
      ['u8', [0n, 255n]],
      ['u16', [0n, 65_535n]],
      ['u32', [0n, 4_294_967_295n]],
      ['u64', [0n, 18_446_744_073_709_551_615n]],
      ['i64', [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]],
    ] as const) {
      for (const value of values) expect(() => validateProtocolFieldValue(type, value)).not.toThrow();
    }
    expect(() => validateProtocolFieldValue('i64', -9_223_372_036_854_775_809n)).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_INTEGER_RANGE' }),
    );
  });

  it('rejects unknown tuples, wrong arity, maps, missing positions, and extra positions', () => {
    expect(() => validateProtocolTuple('UnknownV1' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_UNKNOWN_TUPLE' }),
    );
    expect(() => validateProtocolTuple('__proto__' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_UNKNOWN_TUPLE' }),
    );
    expect(() => validateProtocolTuple('GetVectorV1', [])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_ARITY' }),
    );
    expect(() => decodeProtocolTuple('GetVectorV1', Uint8Array.of(0xa0))).toThrow(
      expect.objectContaining({ code: 'WAL_CBOR_MAP_FORBIDDEN' }),
    );
    expect(() => validateProtocolTuple('GetVectorV1', [byte(0), null])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_ARITY' }),
    );
  });

  it('enforces explicit WalObject sequence links and keyed uniqueness', () => {
    const wal = sampleTuple('WalObjectV1');
    expect(() => validateProtocolTuple('WalObjectV1', [...wal.slice(0, 4), 0n, byte(1), ...wal.slice(6)])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SEMANTIC' }),
    );
    expect(() => validateProtocolTuple('WalObjectV1', [...wal.slice(0, 4), 1n, null, ...wal.slice(6)])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SEMANTIC' }),
    );

    const writer = byte(2, 20);
    expect(() => validateProtocolTuple('ExpectedNamespaceV1', [
      byte(0),
      [[writer, byte(0)], [writer, byte(1)]],
    ])).toThrow(expect.objectContaining({ code: 'WAL_SCHEMA_SET_DUPLICATE' }));

    const signatureA = byte(1, 65);
    const signatureB = byte(2, 65);
    const membership = sampleTuple('MembershipCheckpointV1');
    membership[membership.length - 1] = [[writer, signatureA], [writer, signatureB]];
    expect(() => validateProtocolTuple('MembershipCheckpointV1', membership)).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SET_DUPLICATE' }),
    );

    const vector = sampleTuple('CollectionHeadVectorV1');
    vector[3] = [[byte(0), []], [byte(0), [[writer, byte(1)]]]];
    expect(() => validateProtocolTuple('CollectionHeadVectorV1', vector)).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_SET_DUPLICATE' }),
    );
  });

  it('extracts and validates exact unsigned forms only for signed tuples', () => {
    const wal = sampleTuple('WalObjectV1');
    expect(unsignedProtocolTuple('WalObjectV1', wal as never)).toEqual(wal.slice(0, 7));
    expect(() => validateUnsignedProtocolTuple('WalObjectV1', wal.slice(0, 6))).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_ARITY' }),
    );
    expect(() => validateUnsignedProtocolTuple(
      'WalObjectV1',
      [...wal.slice(0, 4), 1n, null, wal[6]],
    )).toThrow(expect.objectContaining({ code: 'WAL_SCHEMA_SEMANTIC' }));
    expect(() => validateUnsignedProtocolTuple('GetHeadV1' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_DOMAIN' }),
    );
    expect(() => validateUnsignedProtocolTuple('UnknownV1' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SCHEMA_UNKNOWN_TUPLE' }),
    );
  });
});
