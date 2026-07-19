import { compareCanonicalCbor, decodeCanonicalCbor, encodeCanonicalCbor } from './canonical-cbor.js';
import { protocolError } from './errors.js';
import {
  PROTOCOL_TUPLES,
  WAL_V1_ENUMS,
  type CborProtocolValue,
  type ProtocolTuple,
  type ProtocolTupleName,
  type ProtocolTupleSchema,
  type SignedProtocolTupleName,
} from './schema.js';

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MIN_I64 = -0x8000_0000_0000_0000n;
const MAX_I64 = 0x7fff_ffff_ffff_ffffn;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function assertInteger(value: CborProtocolValue, minimum: bigint, maximum: bigint, path: string): void {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) {
    protocolError('WAL_SCHEMA_INTEGER_RANGE', `${path} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function assertBytes(value: CborProtocolValue, length: number | null, path: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== null && value.length !== length)) {
    protocolError(
      'WAL_SCHEMA_FIELD_TYPE',
      length === null ? `${path} must be a byte string` : `${path} must be exactly ${length} bytes`,
    );
  }
}

function assertSortedUnique(values: readonly CborProtocolValue[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const comparison = compareCanonicalCbor(values[index - 1], values[index]);
    if (comparison === 0) protocolError('WAL_SCHEMA_SET_DUPLICATE', `${path} contains a duplicate value`);
    if (comparison > 0) protocolError('WAL_SCHEMA_SET_ORDER', `${path} must be sorted by canonical bytes`);
  }
}

function validateField(type: string, value: CborProtocolValue, path: string): void {
  if (type.endsWith('|null')) {
    if (value === null) return;
    validateField(type.slice(0, -5), value, path);
    return;
  }
  const collection = /^(sorted-unique|strictly-sorted-unique|array)<(.+)>$/.exec(type);
  if (collection) {
    if (!Array.isArray(value)) protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must be an array`);
    for (let index = 0; index < value.length; index += 1) {
      validateField(collection[2], value[index], `${path}[${index}]`);
    }
    if (collection[1] !== 'array') assertSortedUnique(value, path);
    return;
  }
  if (type === 'literal-1' || type === 'literal-0') {
    const expected = type === 'literal-1' ? 1n : 0n;
    if (value !== expected) protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must equal ${expected}`);
    return;
  }
  if (type === 'true') {
    if (value !== true) protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must be literal true`);
    return;
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must be boolean`);
    return;
  }
  if (type === 'u8' || type === 'u8-enum') return assertInteger(value, 0n, 0xffn, path);
  if (type === 'u16' || type === 'u16-enum') return assertInteger(value, 0n, 0xffffn, path);
  if (type === 'u32') return assertInteger(value, 0n, 0xffff_ffffn, path);
  if (type === 'u64') return assertInteger(value, 0n, MAX_U64, path);
  if (type === 'i64') return assertInteger(value, MIN_I64, MAX_I64, path);
  if (type === 'bstr') return assertBytes(value, null, path);
  if (type === 'address20') return assertBytes(value, 20, path);
  if (type === 'signature65') return assertBytes(value, 65, path);
  if (/^bytes\d+$/.test(type)) return assertBytes(value, Number(type.slice(5)), path);
  if (type === 'nfc-tstr') {
    if (typeof value !== 'string' || value !== value.normalize('NFC')) {
      protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must be NFC text`);
    }
    return;
  }
  if (type === 'tuple') {
    if (!Array.isArray(value)) protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} must be a tuple`);
    return;
  }
  if (Object.hasOwn(PROTOCOL_TUPLES, type)) {
    validateTupleValue(type as ProtocolTupleName, value, path);
    return;
  }
  protocolError('WAL_SCHEMA_FIELD_TYPE', `${path} uses unknown schema type ${type}`);
}

function assertUniqueTupleKeys(
  value: CborProtocolValue,
  arrayField: number,
  keyField: number,
  path: string,
): void {
  const entries = (value as readonly CborProtocolValue[])[arrayField] as readonly (readonly CborProtocolValue[])[];
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    const left = previous[keyField];
    const right = current[keyField];
    if (left instanceof Uint8Array && right instanceof Uint8Array && bytesEqual(left, right)) {
      protocolError('WAL_SCHEMA_SET_DUPLICATE', `${path} contains a duplicate key`);
    }
  }
}

function validateEnumRules(name: ProtocolTupleName, value: readonly CborProtocolValue[]): void {
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  for (const [fieldIndexText, enumName] of Object.entries(schema.enumFields ?? {})) {
    const fieldIndex = Number(fieldIndexText);
    const allowed = Object.values(WAL_V1_ENUMS[enumName]).map(BigInt);
    if (!allowed.includes(value[fieldIndex] as bigint)) {
      protocolError(
        'WAL_SCHEMA_ENUM_VALUE',
        `${name}.${schema.fields[fieldIndex]} is not a defined ${enumName} value`,
      );
    }
  }
}

function validateWalObjectSequence(value: readonly CborProtocolValue[]): void {
  const sequence = value[4] as bigint;
  const previous = value[5];
  if ((sequence === 0n) !== (previous === null)) {
    protocolError(
      'WAL_SCHEMA_SEMANTIC',
      'WalObjectV1 sequence zero requires null previousObjectId and nonzero sequence requires a link',
    );
  }
}

function validateSemanticRules(name: ProtocolTupleName, value: readonly CborProtocolValue[]): void {
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  validateEnumRules(name, value);
  if (name === 'WalObjectV1') validateWalObjectSequence(value);
  if (name === 'ExpectedNamespaceV1') assertUniqueTupleKeys(value, 1, 0, name);
  if (name === 'CollectionHeadVectorV1') assertUniqueTupleKeys(value, 3, 0, name);
  if (schema.signed === 'threshold') assertUniqueTupleKeys(value, value.length - 1, 0, `${name}.signatures`);
}

function validateUnsignedSemanticRules(name: SignedProtocolTupleName, value: readonly CborProtocolValue[]): void {
  validateEnumRules(name, value);
  if (name === 'WalObjectV1') validateWalObjectSequence(value);
}

function validateTupleValue(name: ProtocolTupleName, value: CborProtocolValue, path: string): void {
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  if (!Array.isArray(value) || value.length !== schema.fieldTypes.length) {
    protocolError('WAL_SCHEMA_ARITY', `${path} must be an exact ${schema.fieldTypes.length}-item tuple`);
  }
  for (let index = 0; index < schema.fieldTypes.length; index += 1) {
    validateField(schema.fieldTypes[index], value[index], `${path}.${schema.fields[index]}`);
  }
  validateSemanticRules(name, value);
}

export function validateProtocolFieldValue(type: string, value: CborProtocolValue): void {
  validateField(type, value, type);
}

export function validateProtocolTuple<Name extends ProtocolTupleName>(
  name: Name,
  value: CborProtocolValue,
): asserts value is ProtocolTuple<Name> {
  if (!Object.hasOwn(PROTOCOL_TUPLES, name)) {
    protocolError('WAL_SCHEMA_UNKNOWN_TUPLE', `unknown protocol tuple ${name}`);
  }
  validateTupleValue(name, value, name);
}

export function encodeProtocolTuple<Name extends ProtocolTupleName>(
  name: Name,
  value: ProtocolTuple<Name>,
): Uint8Array {
  validateProtocolTuple(name, value);
  return encodeCanonicalCbor(value);
}

export function decodeProtocolTuple<Name extends ProtocolTupleName>(
  name: Name,
  bytes: Uint8Array,
): ProtocolTuple<Name> {
  const value = decodeCanonicalCbor(bytes);
  validateProtocolTuple(name, value);
  return value;
}

export function unsignedProtocolTuple<Name extends SignedProtocolTupleName>(
  name: Name,
  value: ProtocolTuple<Name>,
): readonly CborProtocolValue[] {
  validateProtocolTuple(name, value);
  return value.slice(0, -1);
}

export function validateUnsignedProtocolTuple<Name extends SignedProtocolTupleName>(
  name: Name,
  value: readonly CborProtocolValue[],
): void {
  const schema: ProtocolTupleSchema | undefined = PROTOCOL_TUPLES[name];
  if (!schema) protocolError('WAL_SCHEMA_UNKNOWN_TUPLE', `unknown protocol tuple ${name}`);
  if (!schema.signed) protocolError('WAL_SIGNATURE_DOMAIN', `${name} is not a signed tuple`);
  if (!Array.isArray(value) || value.length !== schema.fieldTypes.length - 1) {
    protocolError('WAL_SCHEMA_ARITY', `${name} unsigned form has the wrong arity`);
  }
  for (let index = 0; index < value.length; index += 1) {
    validateField(schema.fieldTypes[index], value[index], `${name}.${schema.fields[index]}`);
  }
  validateUnsignedSemanticRules(name, value);
}
