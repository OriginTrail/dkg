import { open, type FileHandle } from 'node:fs/promises';
import { blake3 } from '@noble/hashes/blake3.js';
import { WAL_V1_DOMAINS } from '../protocol/schema.js';
import { recoverEip191Address } from '../protocol/signatures.js';
import { WalProtocolError } from '../protocol/errors.js';
import { WalObjectStoreError, storeError } from './errors.js';

const textEncoder = new TextEncoder();
const HARD_WAL_OBJECT_BYTES = 8_589_934_592n;

interface CborHeader {
  major: number;
  argument: bigint;
  byteLength: number;
  initial: number;
}

export interface StreamingWalObjectVerification {
  objectId: Uint8Array;
  writerId: Uint8Array;
  payloadLength: bigint;
  byteLength: bigint;
  maximumReadBufferBytes: number;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function readExact(file: FileHandle, offset: bigint, length: number): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  const { bytesRead } = await file.read(output, 0, length, Number(offset));
  if (bytesRead !== length) {
    return storeError('WAL_STORE_INVALID_OBJECT', 'truncated WalObjectV1 bytes');
  }
  return output;
}

async function readHeader(file: FileHandle, offset: bigint): Promise<CborHeader> {
  const initial = (await readExact(file, offset, 1))[0];
  const major = initial >>> 5;
  const additional = initial & 31;
  if (additional < 24) return { major, argument: BigInt(additional), byteLength: 1, initial };
  if (additional === 31 || additional > 27) {
    return storeError('WAL_STORE_INVALID_OBJECT', 'indefinite or reserved CBOR argument in WalObjectV1');
  }
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 8;
  const encoded = await readExact(file, offset + 1n, width);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const argument = width === 1
    ? BigInt(encoded[0])
    : width === 2
      ? BigInt(view.getUint16(0, false))
      : width === 4
        ? BigInt(view.getUint32(0, false))
        : view.getBigUint64(0, false);
  const minimum = width === 1 ? 24n : width === 2 ? 256n : width === 4 ? 65_536n : 4_294_967_296n;
  if (argument < minimum) {
    return storeError('WAL_STORE_INVALID_OBJECT', 'non-shortest CBOR argument in WalObjectV1');
  }
  return { major, argument, byteLength: width + 1, initial };
}

async function readUnsignedInteger(
  file: FileHandle,
  offset: bigint,
): Promise<{ value: bigint; next: bigint }> {
  const header = await readHeader(file, offset);
  if (header.major !== 0) {
    return storeError('WAL_STORE_INVALID_OBJECT', 'expected unsigned integer in WalObjectV1');
  }
  return { value: header.argument, next: offset + BigInt(header.byteLength) };
}

async function readByteString(
  file: FileHandle,
  offset: bigint,
  requiredLength?: bigint,
): Promise<{ bodyOffset: bigint; length: bigint; next: bigint }> {
  const header = await readHeader(file, offset);
  if (header.major !== 2) {
    return storeError('WAL_STORE_INVALID_OBJECT', 'expected byte string in WalObjectV1');
  }
  if (requiredLength !== undefined && header.argument !== requiredLength) {
    return storeError('WAL_STORE_INVALID_OBJECT', `WalObjectV1 byte string must contain ${requiredLength} bytes`);
  }
  const bodyOffset = offset + BigInt(header.byteLength);
  return { bodyOffset, length: header.argument, next: bodyOffset + header.argument };
}

async function updateFromFile(
  file: FileHandle,
  start: bigint,
  end: bigint,
  chunkBytes: number,
  update: (bytes: Uint8Array) => void,
): Promise<number> {
  let offset = start;
  let maximum = 0;
  while (offset < end) {
    const remaining = end - offset;
    const length = Number(remaining > BigInt(chunkBytes) ? BigInt(chunkBytes) : remaining);
    const bytes = await readExact(file, offset, length);
    update(bytes);
    maximum = Math.max(maximum, bytes.length);
    offset += BigInt(length);
  }
  return maximum;
}

export async function verifyWalObjectFile(
  path: string,
  expectedId: Uint8Array,
  options: { maximumObjectBytes: bigint; readBufferBytes: number },
): Promise<StreamingWalObjectVerification> {
  if (!(expectedId instanceof Uint8Array) || expectedId.length !== 32) {
    return storeError('WAL_STORE_INVALID_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
  if (
    options.maximumObjectBytes < 1n
    || options.maximumObjectBytes > HARD_WAL_OBJECT_BYTES
    || !Number.isSafeInteger(options.readBufferBytes)
    || options.readBufferBytes < 1
    || options.readBufferBytes > 1_048_576
  ) {
    return storeError('WAL_STORE_INVALID_CONFIGURATION', 'invalid streaming verification limits');
  }

  const file = await open(path, 'r');
  try {
    const details = await file.stat({ bigint: true });
    if (!details.isFile()) return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject path must be a regular file');
    if (details.size > options.maximumObjectBytes) {
      return storeError('WAL_STORE_OBJECT_TOO_LARGE', 'WalObjectV1 exceeds the configured object limit');
    }
    let offset = 0n;
    const tuple = await readHeader(file, offset);
    if (tuple.major !== 4 || tuple.argument !== 8n) {
      return storeError('WAL_STORE_INVALID_OBJECT', 'WalObjectV1 must be an exact eight-position canonical tuple');
    }
    offset += 1n;
    const unsignedFieldsStart = offset;

    const version = await readUnsignedInteger(file, offset);
    if (version.value !== 1n) return storeError('WAL_STORE_INVALID_OBJECT', 'unsupported WalObjectV1 version');
    offset = version.next;
    const namespace = await readByteString(file, offset, 32n);
    offset = namespace.next;
    const writer = await readByteString(file, offset, 20n);
    const writerId = await readExact(file, writer.bodyOffset, 20);
    offset = writer.next;
    const writerEpoch = await readUnsignedInteger(file, offset);
    offset = writerEpoch.next;
    const sequence = await readUnsignedInteger(file, offset);
    offset = sequence.next;

    const previous = await readHeader(file, offset);
    if (previous.initial === 0xf6) {
      if (sequence.value !== 0n) {
        return storeError('WAL_STORE_INVALID_OBJECT', 'nonzero sequence requires previousObjectId');
      }
      offset += 1n;
    } else {
      const previousObjectId = await readByteString(file, offset, 32n);
      if (sequence.value === 0n) {
        return storeError('WAL_STORE_INVALID_OBJECT', 'sequence zero requires null previousObjectId');
      }
      offset = previousObjectId.next;
    }

    const payload = await readByteString(file, offset);
    offset = payload.next;
    const unsignedFieldsEnd = offset;
    const signatureField = await readByteString(file, offset, 65n);
    const signature = await readExact(file, signatureField.bodyOffset, 65);
    offset = signatureField.next;
    if (offset !== details.size) {
      return storeError('WAL_STORE_INVALID_OBJECT', 'trailing or truncated WalObjectV1 bytes');
    }

    const signingHasher = blake3.create({});
    signingHasher.update(textEncoder.encode(WAL_V1_DOMAINS.walObjectSignature));
    signingHasher.update(Uint8Array.of(0x87));
    let maximumReadBufferBytes = await updateFromFile(
      file,
      unsignedFieldsStart,
      unsignedFieldsEnd,
      options.readBufferBytes,
      bytes => signingHasher.update(bytes),
    );
    const recovered = recoverEip191Address(signingHasher.digest(), signature);
    if (!equalBytes(recovered, writerId)) {
      return storeError('WAL_STORE_INVALID_OBJECT', 'WalObjectV1 signature does not match writerId');
    }

    const identityHasher = blake3.create({});
    identityHasher.update(textEncoder.encode(WAL_V1_DOMAINS.walObjectId));
    maximumReadBufferBytes = Math.max(maximumReadBufferBytes, await updateFromFile(
      file,
      0n,
      details.size,
      options.readBufferBytes,
      bytes => identityHasher.update(bytes),
    ));
    const objectId = identityHasher.digest();
    if (!equalBytes(objectId, expectedId)) {
      return storeError('WAL_STORE_OBJECT_ID_MISMATCH', 'complete bytes do not match the expected WalObjectId');
    }
    return {
      objectId,
      writerId,
      payloadLength: payload.length,
      byteLength: details.size,
      maximumReadBufferBytes,
    };
  } catch (error) {
    if (error instanceof WalObjectStoreError) throw error;
    /* v8 ignore next -- all expected parse failures above are WalObjectStoreError or WalProtocolError. */
    if (!(error instanceof WalProtocolError)) {
      /* v8 ignore start -- protects against unexpected filesystem or hash implementation failures. */
      return storeError(
        'WAL_STORE_IO',
        `failed to verify WalObjectV1: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
      /* v8 ignore stop */
    }
    return storeError('WAL_STORE_INVALID_OBJECT', `invalid WalObjectV1 signature: ${error.message}`, error);
  } finally {
    await file.close();
  }
}
