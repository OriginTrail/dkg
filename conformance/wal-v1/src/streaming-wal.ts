import { open } from 'node:fs/promises';
import { blake3 } from '@noble/hashes/blake3.js';
import { getBytes, hashMessage, recoverAddress } from 'ethers';
import { equalBytes, hex, utf8 } from './bytes.js';
import { DOMAINS, LIMITS } from './schema.js';

interface Header {
  major: number;
  argument: bigint;
  bytes: number;
  initial: number;
}

export interface StreamingWalVerification {
  id: Uint8Array;
  writerId: Uint8Array;
  payloadLength: bigint;
  maximumReadBufferBytes: number;
}

async function readExact(file: Awaited<ReturnType<typeof open>>, offset: bigint, length: number): Promise<Uint8Array> {
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture file offset exceeds platform API');
  const output = new Uint8Array(length);
  const { bytesRead } = await file.read(output, 0, length, Number(offset));
  if (bytesRead !== length) throw new Error('truncated WalObjectV1');
  return output;
}

async function header(file: Awaited<ReturnType<typeof open>>, offset: bigint): Promise<Header> {
  const first = (await readExact(file, offset, 1))[0];
  const major = first >>> 5;
  const ai = first & 31;
  if (ai < 24) return { major, argument: BigInt(ai), bytes: 1, initial: first };
  if (ai === 31 || ai > 27) throw new Error('indefinite or reserved CBOR argument');
  const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
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
  if (argument < minimum) throw new Error('non-shortest CBOR argument');
  return { major, argument, bytes: width + 1, initial: first };
}

async function integer(file: Awaited<ReturnType<typeof open>>, offset: bigint): Promise<{ value: bigint; next: bigint }> {
  const item = await header(file, offset);
  if (item.major !== 0) throw new Error('expected unsigned integer');
  return { value: item.argument, next: offset + BigInt(item.bytes) };
}

async function byteString(
  file: Awaited<ReturnType<typeof open>>,
  offset: bigint,
  requiredLength?: bigint
): Promise<{ bodyOffset: bigint; length: bigint; next: bigint }> {
  const item = await header(file, offset);
  if (item.major !== 2) throw new Error('expected byte string');
  if (requiredLength !== undefined && item.argument !== requiredLength) throw new Error('byte string length mismatch');
  const bodyOffset = offset + BigInt(item.bytes);
  return { bodyOffset, length: item.argument, next: bodyOffset + item.argument };
}

async function updateFromFile(
  file: Awaited<ReturnType<typeof open>>,
  start: bigint,
  end: bigint,
  update: (bytes: Uint8Array) => void,
  chunkBytes: number
): Promise<number> {
  let offset = start;
  let maximum = 0;
  while (offset < end) {
    const length = Number((end - offset) > BigInt(chunkBytes) ? BigInt(chunkBytes) : end - offset);
    const bytes = await readExact(file, offset, length);
    maximum = Math.max(maximum, bytes.length);
    update(bytes);
    offset += BigInt(length);
  }
  return maximum;
}

export async function verifyWalObjectFileStreaming(
  path: string,
  expectedId?: Uint8Array,
  chunkBytes = 65_536
): Promise<StreamingWalVerification> {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > LIMITS.walObjectRangeBytes) {
    throw new Error('invalid streaming verification buffer');
  }
  const file = await open(path, 'r');
  try {
    const stat = await file.stat({ bigint: true });
    if (stat.size > BigInt(LIMITS.walObjectHardBytes)) throw new Error('WalObjectV1 exceeds hard size');
    let offset = 0n;
    const tupleHeader = await header(file, offset);
    if (tupleHeader.major !== 4 || tupleHeader.argument !== 8n || tupleHeader.bytes !== 1) throw new Error('WalObjectV1 arity');
    offset += 1n;
    const signedFieldsStart = offset;
    const version = await integer(file, offset);
    if (version.value !== 1n) throw new Error('WalObjectV1 version');
    offset = version.next;
    const namespace = await byteString(file, offset, 32n);
    offset = namespace.next;
    const writer = await byteString(file, offset, 20n);
    const writerId = await readExact(file, writer.bodyOffset, 20);
    offset = writer.next;
    const writerEpoch = await integer(file, offset);
    offset = writerEpoch.next;
    const sequence = await integer(file, offset);
    offset = sequence.next;
    const previousHeader = await header(file, offset);
    if (previousHeader.initial === 0xf6) {
      if (sequence.value !== 0n) throw new Error('nonzero sequence requires previousObjectId');
      offset += 1n;
    } else {
      const previous = await byteString(file, offset, 32n);
      if (sequence.value === 0n) throw new Error('sequence zero requires null previousObjectId');
      offset = previous.next;
    }
    const payload = await byteString(file, offset);
    if (payload.length > BigInt(LIMITS.walObjectHardBytes)) throw new Error('payload exceeds hard size');
    offset = payload.next;
    const signedFieldsEnd = offset;
    const signatureField = await byteString(file, offset, 65n);
    const signature = await readExact(file, signatureField.bodyOffset, 65);
    offset = signatureField.next;
    if (offset !== stat.size) throw new Error('trailing or truncated WalObjectV1 bytes');

    const domain = utf8(DOMAINS.walObjectSignature);
    const signingHasher = blake3.create({});
    signingHasher.update(domain);
    signingHasher.update(Uint8Array.of(0x87));
    let maximumReadBufferBytes = await updateFromFile(
      file,
      signedFieldsStart,
      signedFieldsEnd,
      (bytes) => signingHasher.update(bytes),
      chunkBytes
    );
    const signingDigest = signingHasher.digest();
    const recovered = getBytes(recoverAddress(hashMessage(signingDigest), `0x${hex(signature)}`));
    if (!equalBytes(recovered, writerId)) throw new Error('invalid WalObjectV1 signature');

    const idHasher = blake3.create({});
    maximumReadBufferBytes = Math.max(maximumReadBufferBytes, await updateFromFile(
      file,
      0n,
      stat.size,
      (bytes) => idHasher.update(bytes),
      chunkBytes
    ));
    const id = idHasher.digest();
    if (expectedId !== undefined && !equalBytes(id, expectedId)) throw new Error('WalObjectId mismatch');
    return { id, writerId, payloadLength: payload.length, maximumReadBufferBytes };
  } finally {
    await file.close();
  }
}
