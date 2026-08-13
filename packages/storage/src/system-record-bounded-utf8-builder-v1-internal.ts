export interface SystemRecordUtf8WriterV1 {
  add(value: string): void;
}

export interface BoundedSystemRecordUtf8BuildV1 {
  readonly value: string;
  readonly encodedBytes: number;
}

/**
 * The stable code a REFUSAL carries, so callers can distinguish "this request is too big
 * to ask" from an accounting defect in this builder without reading English text.
 *
 * A bound refusal is an expected condition for a caller that can degrade — the legacy
 * gate reports it as an undecidable answer rather than failing its page. An accounting
 * mismatch is a defect here and keeps propagating untagged.
 */
export const SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW_V1 = 'SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW';

export function isSystemRecordBoundedBuildOverflowV1(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW_V1;
}

function boundedBuildOverflowV1(message: string): Error {
  return Object.assign(new Error(message), { code: SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW_V1 });
}

export function buildBoundedSystemRecordUtf8V1(input: Readonly<{
  emit(writer: SystemRecordUtf8WriterV1): void;
  maxEncodedBytes: number;
  maxRetainedBytes: number;
  label: string;
  replaceCharge?: (retainedBytes: number) => void;
}>): BoundedSystemRecordUtf8BuildV1 {
  let encodedBytes = 0;
  input.emit({
    add(value): void {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > input.maxEncodedBytes - encodedBytes) {
        throw boundedBuildOverflowV1(`${input.label} exceeds its encoded-byte bound`);
      }
      encodedBytes += bytes;
    },
  });
  const peakRetainedBytes = encodedBytes * 3;
  if (peakRetainedBytes > input.maxRetainedBytes) {
    throw boundedBuildOverflowV1(`${input.label} exceeds its retained-byte bound`);
  }
  input.replaceCharge?.(peakRetainedBytes);
  let buffer: Buffer | null = Buffer.allocUnsafe(encodedBytes);
  let offset = 0;
  input.emit({
    add(value): void {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (buffer === null || bytes > encodedBytes - offset) {
        throw new Error(`${input.label} accounting mismatch`);
      }
      const written = buffer.write(value, offset, bytes, 'utf8');
      if (written !== bytes) throw new Error(`${input.label} accounting mismatch`);
      offset += written;
    },
  });
  if (buffer === null || offset !== encodedBytes) {
    throw new Error(`${input.label} accounting mismatch`);
  }
  const value = buffer.toString('utf8');
  buffer = null;
  input.replaceCharge?.(encodedBytes * 2);
  if (Buffer.byteLength(value, 'utf8') !== encodedBytes) {
    throw new Error(`${input.label} accounting mismatch`);
  }
  return Object.freeze({ value, encodedBytes });
}
