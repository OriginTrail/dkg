import { describe, expect, it } from 'vitest';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  applyDecodedDifference,
  bytesToHex,
  createFallbackPages,
  hashBytes,
  verifyDecodedDifference,
  verifyFallbackPages,
  verifySetAgainstHead,
  walObjectId,
  type ReconciliationHead,
  type WalObjectId
} from '../../src/reconciliation/index.js';
import { deterministicHead, deterministicSeed } from '../support/fixtures.js';

const encoder = new TextEncoder();

/** Test-only object store. Values are complete canonical WalObjectV1 byte strings. */
class FakeWalObjectStore {
  readonly #objects = new Map<string, Uint8Array>();

  constructor(objects: readonly Uint8Array[] = []) {
    for (const object of objects) this.put(object);
  }

  put(object: Uint8Array): WalObjectId {
    const id = walObjectId(hashBytes(object));
    this.#objects.set(bytesToHex(id), new Uint8Array(object));
    return id;
  }

  putVerified(id: WalObjectId, object: Uint8Array): void {
    expect(walObjectId(hashBytes(object))).toEqual(id);
    this.#objects.set(bytesToHex(id), new Uint8Array(object));
  }

  get(id: WalObjectId): Uint8Array {
    const object = this.#objects.get(bytesToHex(id));
    if (object === undefined) throw new Error(`missing complete WalObjectV1: ${bytesToHex(id)}`);
    return new Uint8Array(object);
  }

  delete(id: WalObjectId): void {
    expect(this.#objects.delete(bytesToHex(id))).toBe(true);
  }

  ids(): WalObjectId[] {
    return [...this.#objects.keys()].map((hex) => {
      const bytes = Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
      return walObjectId(bytes);
    });
  }
}

function walObject(label: string, payloadBytes = 64): Uint8Array {
  const header = encoder.encode(`WalObjectV1\0${label}\0`);
  const object = new Uint8Array(header.length + payloadBytes);
  object.set(header);
  for (let index = header.length; index < object.length; index += 1) {
    object[index] = (index * 131 + label.length * 17) & 0xff;
  }
  return object;
}

function transferDecodedObjects(
  provider: FakeWalObjectStore,
  receiver: FakeWalObjectStore,
  providerOnly: readonly WalObjectId[],
  receiverOnly: readonly WalObjectId[]
): void {
  for (const id of receiverOnly) receiver.delete(id);
  for (const id of providerOnly) receiver.putVerified(id, provider.get(id));
}

function reconcileOverEncodedWindows(
  provider: FakeWalObjectStore,
  receiver: FakeWalObjectStore,
  head: ReconciliationHead
): { symbols: number; transferred: number } {
  const providerIds = provider.ids();
  const receiverIds = receiver.ids();
  const reconciliationSeed = deterministicSeed('wal-e2e');
  const symbolEncoder = new RatelessIbltEncoder({
    ids: providerIds,
    reconciliationSeed,
    algorithm: PAPER_BASELINE_V0.algorithm
  });
  const symbolDecoder = new RatelessIbltDecoder({
    receiverIds,
    reconciliationSeed,
    algorithm: PAPER_BASELINE_V0.algorithm
  });
  let window = 1;
  while (!symbolDecoder.complete && symbolDecoder.receivedSymbols < 1_024) {
    symbolDecoder.addEncodedProviderWindow(symbolEncoder.produceEncodedWindow(window));
    window *= 2;
  }
  const decoded = symbolDecoder.snapshot();
  verifyDecodedDifference(receiverIds, decoded, head);
  transferDecodedObjects(provider, receiver, decoded.providerOnly, decoded.receiverOnly);
  expect(applyDecodedDifference(receiverIds, decoded.providerOnly, decoded.receiverOnly)).toEqual(
    receiver.ids().sort((left, right) => bytesToHex(left).localeCompare(bytesToHex(right)))
  );
  verifySetAgainstHead(receiver.ids(), head);
  return { symbols: decoded.receivedSymbols, transferred: decoded.providerOnly.length };
}

describe('WAL reconciliation and complete-object transfer', () => {
  it('reconciles IDs over canonical byte windows and transfers only complete WalObjectV1 atoms', () => {
    const common = Array.from({ length: 40 }, (_, index) => walObject(`common:${index}`, 128 + index));
    const providerOnly = Array.from({ length: 7 }, (_, index) => walObject(`provider:${index}`, 4_096 + index));
    const receiverOnly = Array.from({ length: 5 }, (_, index) => walObject(`receiver:${index}`, 256 + index));
    const provider = new FakeWalObjectStore([...common, ...providerOnly]);
    const receiver = new FakeWalObjectStore([...common, ...receiverOnly]);
    const head = deterministicHead('wal-e2e-head', provider.ids());

    const result = reconcileOverEncodedWindows(provider, receiver, head);
    expect(result.symbols).toBeGreaterThan(0);
    expect(result.transferred).toBe(providerOnly.length);
    for (const id of provider.ids()) expect(receiver.get(id)).toEqual(provider.get(id));
  });

  it('backfills an empty receiver through head-bound pages before whole-object transfer', () => {
    const provider = new FakeWalObjectStore(
      Array.from({ length: 23 }, (_, index) => walObject(`backfill:${index}`, 1_024 + index))
    );
    const receiver = new FakeWalObjectStore();
    const head = deterministicHead('wal-backfill-head', provider.ids());
    const pages = createFallbackPages(provider.ids(), head, 5);
    const missingIds = verifyFallbackPages(pages, head);
    for (const id of missingIds) receiver.putVerified(id, provider.get(id));
    verifySetAgainstHead(receiver.ids(), head);
    expect(pages).toHaveLength(5);
    expect(receiver.ids()).toHaveLength(23);
  });

  it('rejects corrupted object bytes before they enter the receiver store', () => {
    const object = walObject('corruption');
    const id = walObjectId(hashBytes(object));
    const corrupted = new Uint8Array(object);
    corrupted[corrupted.length - 1] ^= 1;
    const receiver = new FakeWalObjectStore();
    expect(() => receiver.putVerified(id, corrupted)).toThrow();
    expect(receiver.ids()).toEqual([]);
  });
});
