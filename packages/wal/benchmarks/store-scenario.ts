import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { createWalObjectV1, type UnsignedWalObjectV1 } from '../src/protocol/wal-object.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  type WalEip191Signer,
} from '../src/protocol/signatures.js';
import { walObjectId, type WalObjectId } from '../src/reconciliation/ids.js';
import { PackedWalObjectStore } from '../src/store/packed-store.js';
import { FileWalObjectRangeReceiver } from '../src/store/range-receiver.js';

const READ_BUFFER_BYTES = 32_768;
const RANGE_BYTES = 1_048_576;
const INVENTORY_BATCH_ROWS = 100_000;

interface ProtocolVectors {
  fixturePrivateKey: string;
  walObjects: { first: { canonicalBytes: string; walObjectId: string } };
}

export interface StoreLatencyDistribution {
  operations: number;
  totalMs: number;
  operationsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maximumMs: number;
}

export interface StoreBenchmarkResult {
  objectCount: number;
  fixtureMode: 'sqlite-index-aliases-with-separate-verified-admission';
  fixtureObjectBytes: number;
  inventoryPreparationMs: number;
  inventoryPreparationObjectsPerSecond: number;
  enumerate: { objects: number; totalMs: number; objectsPerSecond: number };
  hasHit: StoreLatencyDistribution;
  hasMiss: StoreLatencyDistribution;
  fullRead: StoreLatencyDistribution & { bytes: number; mebibytesPerSecond: number };
  rangedRead: StoreLatencyDistribution & { bytes: number; mebibytesPerSecond: number };
  verifiedAdmission: StoreLatencyDistribution & { bytes: number; mebibytesPerSecond: number };
  idempotentAdmission: StoreLatencyDistribution;
  largeObject: {
    payloadBytes: number;
    canonicalBytes: number;
    putMs: number;
    putMebibytesPerSecond: number;
    fullReadMs: number;
    fullReadMebibytesPerSecond: number;
    rangedReadMs: number;
    rangedReadMebibytesPerSecond: number;
    rangedReadOperations: number;
  };
  rangeReassembly: {
    canonicalBytes: number;
    rangeBytes: number;
    ranges: number;
    totalMs: number;
    mebibytesPerSecond: number;
  };
  totalMs: number;
  cpu: { userMicros: number; systemMicros: number };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
  };
}

export interface StoreBenchmarkOptions {
  root: string;
  objectCount: number;
  operationSamples?: number;
  readSamples?: number;
  admissionSamples?: number;
  largePayloadBytes?: number;
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function syntheticId(index: number, miss = false): WalObjectId {
  const id = new Uint8Array(32);
  id[0] = miss ? 0x7f : 0x7e;
  new DataView(id.buffer).setBigUint64(24, BigInt(index), false);
  return walObjectId(id);
}

function namespaceId(index: number, marker: number): Uint8Array {
  const id = new Uint8Array(32).fill(marker);
  new DataView(id.buffer).setBigUint64(24, BigInt(index), false);
  return id;
}

function percentile(ordered: readonly number[], fraction: number): number {
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

function distribution(latencies: number[]): StoreLatencyDistribution {
  if (latencies.length === 0) throw new Error('store benchmark requires at least one operation');
  const ordered = [...latencies].sort((left, right) => left - right);
  const totalMs = latencies.reduce((sum, value) => sum + value, 0);
  return {
    operations: latencies.length,
    totalMs,
    operationsPerSecond: totalMs === 0 ? Number.POSITIVE_INFINITY : latencies.length / totalMs * 1_000,
    p50Ms: percentile(ordered, 0.5),
    p95Ms: percentile(ordered, 0.95),
    p99Ms: percentile(ordered, 0.99),
    maximumMs: ordered.at(-1)!,
  };
}

function mebibytesPerSecond(bytes: number, milliseconds: number): number {
  return milliseconds === 0 ? Number.POSITIVE_INFINITY : bytes / 1_048_576 / (milliseconds / 1_000);
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

async function consume(source: AsyncIterable<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of source) bytes += chunk.length;
  return bytes;
}

async function createSigner(vectors: ProtocolVectors): Promise<WalEip191Signer> {
  const privateKey = fromHex(vectors.fixturePrivateKey);
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

async function createObjects(count: number, signer: WalEip191Signer, payloadBytes: number, marker: number) {
  const objects: Array<{ id: WalObjectId; bytes: Uint8Array }> = [];
  for (let index = 0; index < count; index += 1) {
    const object = await createWalObjectV1([
      1n,
      namespaceId(index, marker),
      signer.address as Uint8Array,
      0n,
      0n,
      null,
      new Uint8Array(payloadBytes).fill(index & 0xff),
    ] satisfies UnsignedWalObjectV1, signer);
    objects.push({ id: walObjectId(object.walObjectId), bytes: object.canonicalBytes });
  }
  return objects;
}

async function seedInventory(indexPath: string, count: number): Promise<void> {
  if (count <= 1) return;
  const database = new Database(indexPath);
  try {
    database.pragma('synchronous = OFF');
    const target = database.prepare(
      'SELECT segment_id, object_offset, object_length FROM objects ORDER BY object_id LIMIT 1',
    ).get() as { segment_id: number; object_offset: number; object_length: number };
    const insert = database.prepare(
      'INSERT INTO objects(object_id, segment_id, object_offset, object_length) VALUES (?, ?, ?, ?)',
    );
    const batch = database.transaction((start: number, end: number) => {
      for (let index = start; index < end; index += 1) {
        insert.run(Buffer.from(syntheticId(index)), target.segment_id, target.object_offset, target.object_length);
      }
    });
    for (let start = 0; start < count - 1; start += INVENTORY_BATCH_ROWS) {
      batch(start, Math.min(count - 1, start + INVENTORY_BATCH_ROWS));
      await yieldImmediate();
    }
  } finally {
    database.close();
  }
}

async function benchmarkHas(store: PackedWalObjectStore, count: number, samples: number, miss: boolean) {
  const latencies: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const id = syntheticId((sample * 65_537) % Math.max(1, count - 1), miss);
    const started = performance.now();
    const present = await store.has(id);
    latencies.push(performance.now() - started);
    if (present === miss) throw new Error(`store benchmark ${miss ? 'miss' : 'hit'} assertion failed`);
  }
  return distribution(latencies);
}

async function benchmarkReads(
  store: PackedWalObjectStore,
  objects: Array<{ id: WalObjectId; bytes: Uint8Array }>,
  samples: number,
  ranged: boolean,
) {
  const latencies: number[] = [];
  let bytes = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const object = objects[sample % objects.length]!;
    const started = performance.now();
    bytes += await consume(ranged ? store.read(object.id, 8n, 64) : store.read(object.id));
    latencies.push(performance.now() - started);
  }
  const latency = distribution(latencies);
  return { ...latency, bytes, mebibytesPerSecond: mebibytesPerSecond(bytes, latency.totalMs) };
}

async function benchmarkAdmissions(store: PackedWalObjectStore, objects: Array<{ id: WalObjectId; bytes: Uint8Array }>) {
  const latencies: number[] = [];
  let bytes = 0;
  for (const object of objects) {
    const started = performance.now();
    await store.put(object.id, oneChunk(object.bytes));
    latencies.push(performance.now() - started);
    bytes += object.bytes.length;
  }
  const latency = distribution(latencies);
  return { ...latency, bytes, mebibytesPerSecond: mebibytesPerSecond(bytes, latency.totalMs) };
}

async function benchmarkIdempotent(store: PackedWalObjectStore, objects: Array<{ id: WalObjectId; bytes: Uint8Array }>) {
  const latencies: number[] = [];
  for (const object of objects) {
    const started = performance.now();
    await store.put(object.id, oneChunk(object.bytes));
    latencies.push(performance.now() - started);
  }
  return distribution(latencies);
}

async function benchmarkLarge(root: string, object: { id: WalObjectId; bytes: Uint8Array }) {
  const store = new PackedWalObjectStore({
    root: join(root, 'large'),
    maximumObjectBytes: BigInt(object.bytes.length),
    readBufferBytes: READ_BUFFER_BYTES,
    verificationBufferBytes: READ_BUFFER_BYTES,
  });
  try {
    const putStarted = performance.now();
    await store.put(object.id, oneChunk(object.bytes));
    const putMs = performance.now() - putStarted;
    const fullStarted = performance.now();
    const fullBytes = await consume(store.read(object.id));
    const fullReadMs = performance.now() - fullStarted;
    const rangedStarted = performance.now();
    let rangedBytes = 0;
    let rangedReadOperations = 0;
    for (let offset = 0; offset < object.bytes.length; offset += RANGE_BYTES) {
      rangedBytes += await consume(store.read(object.id, BigInt(offset), Math.min(RANGE_BYTES, object.bytes.length - offset)));
      rangedReadOperations += 1;
    }
    const rangedReadMs = performance.now() - rangedStarted;
    if (fullBytes !== object.bytes.length || rangedBytes !== object.bytes.length) throw new Error('large read truncated');
    return {
      payloadBytes: object.bytes.length,
      canonicalBytes: object.bytes.length,
      putMs,
      putMebibytesPerSecond: mebibytesPerSecond(object.bytes.length, putMs),
      fullReadMs,
      fullReadMebibytesPerSecond: mebibytesPerSecond(fullBytes, fullReadMs),
      rangedReadMs,
      rangedReadMebibytesPerSecond: mebibytesPerSecond(rangedBytes, rangedReadMs),
      rangedReadOperations,
    };
  } finally {
    store.close();
  }
}

async function benchmarkRangeReassembly(root: string, object: { id: WalObjectId; bytes: Uint8Array }) {
  const store = new PackedWalObjectStore({ root: join(root, 'range-store'), maximumObjectBytes: BigInt(object.bytes.length) });
  try {
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(root, 'range-staging'),
      store,
      maximumObjectBytes: BigInt(object.bytes.length),
      maximumRangeBytes: RANGE_BYTES,
      assemblyBufferBytes: READ_BUFFER_BYTES,
    });
    const ranges = [];
    for (let offset = 0; offset < object.bytes.length; offset += RANGE_BYTES) {
      ranges.push({ offset, bytes: object.bytes.slice(offset, Math.min(offset + RANGE_BYTES, object.bytes.length)) });
    }
    const reordered = ranges.filter((_, index) => index % 2 === 1).concat(ranges.filter((_, index) => index % 2 === 0));
    const started = performance.now();
    for (const range of reordered) {
      await receiver.accept({
        walObjectId: object.id,
        totalObjectLength: BigInt(object.bytes.length),
        offset: BigInt(range.offset),
        bytes: range.bytes,
      });
    }
    const totalMs = performance.now() - started;
    if (!await store.has(object.id)) throw new Error('range assembly did not promote object');
    return {
      canonicalBytes: object.bytes.length,
      rangeBytes: RANGE_BYTES,
      ranges: ranges.length,
      totalMs,
      mebibytesPerSecond: mebibytesPerSecond(object.bytes.length, totalMs),
    };
  } finally {
    store.close();
  }
}

export async function runStoreBenchmark(options: StoreBenchmarkOptions): Promise<StoreBenchmarkResult> {
  if (!Number.isSafeInteger(options.objectCount) || options.objectCount < 2) throw new RangeError('objectCount must be >= 2');
  const operationSamples = Math.min(options.operationSamples ?? 10_000, options.objectCount);
  const readSamples = Math.min(options.readSamples ?? 1_000, options.objectCount);
  const admissionSamples = options.admissionSamples ?? 16;
  const largePayloadBytes = options.largePayloadBytes ?? 8 * 1_048_576;
  for (const [name, value] of Object.entries({ operationSamples, readSamples, admissionSamples, largePayloadBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const vectors = JSON.parse(await readFile(
    new URL('../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url), 'utf8',
  )) as ProtocolVectors;
  const fixtureBytes = fromHex(vectors.walObjects.first.canonicalBytes);
  const fixtureId = walObjectId(fromHex(vectors.walObjects.first.walObjectId));
  const signer = await createSigner(vectors);
  const admissionObjects = await createObjects(admissionSamples, signer, 256, 0xa1);
  const largeObject = (await createObjects(1, signer, largePayloadBytes, 0xb2))[0]!;
  const storeRoot = join(options.root, 'objects');
  const fixtureStore = new PackedWalObjectStore({ root: storeRoot });
  await fixtureStore.put(fixtureId, oneChunk(fixtureBytes));
  fixtureStore.close();
  const preparationStarted = performance.now();
  await seedInventory(join(storeRoot, 'objects.sqlite'), options.objectCount);
  const inventoryPreparationMs = performance.now() - preparationStarted;
  const store = new PackedWalObjectStore({ root: storeRoot });
  try {
    const totalStarted = performance.now();
    const cpuStarted = process.cpuUsage();
    const enumerationStarted = performance.now();
    let enumerated = 0;
    for await (const _id of store.ids()) enumerated += 1;
    const enumerateMs = performance.now() - enumerationStarted;
    if (enumerated !== options.objectCount) throw new Error(`enumerated ${enumerated}, expected ${options.objectCount}`);
    const hasHit = await benchmarkHas(store, options.objectCount, operationSamples, false);
    const hasMiss = await benchmarkHas(store, options.objectCount, operationSamples, true);
    const verifiedAdmission = await benchmarkAdmissions(store, admissionObjects);
    const idempotentAdmission = await benchmarkIdempotent(store, admissionObjects);
    const fullRead = await benchmarkReads(store, admissionObjects, readSamples, false);
    const rangedRead = await benchmarkReads(store, admissionObjects, readSamples, true);
    const largeObjectResult = await benchmarkLarge(options.root, largeObject);
    largeObjectResult.payloadBytes = largePayloadBytes;
    const rangeReassembly = await benchmarkRangeReassembly(options.root, largeObject);
    const totalMs = performance.now() - totalStarted;
    const cpu = process.cpuUsage(cpuStarted);
    const memory = process.memoryUsage();
    const resources = process.resourceUsage();
    return {
      objectCount: options.objectCount,
      fixtureMode: 'sqlite-index-aliases-with-separate-verified-admission',
      fixtureObjectBytes: fixtureBytes.length,
      inventoryPreparationMs,
      inventoryPreparationObjectsPerSecond: options.objectCount / inventoryPreparationMs * 1_000,
      enumerate: { objects: enumerated, totalMs: enumerateMs, objectsPerSecond: enumerated / enumerateMs * 1_000 },
      hasHit,
      hasMiss,
      fullRead,
      rangedRead,
      verifiedAdmission,
      idempotentAdmission,
      largeObject: largeObjectResult,
      rangeReassembly,
      totalMs,
      cpu: { userMicros: cpu.user, systemMicros: cpu.system },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        maxRssBytes: resources.maxRSS * 1_024,
      },
    };
  } finally {
    store.close();
  }
}
