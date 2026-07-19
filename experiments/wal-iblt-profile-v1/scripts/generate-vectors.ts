import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  bytesToHex,
  createFallbackPages,
  deriveReconciliationSeed,
  encodeReconciliationSymbolV1,
  setCommitment
} from '../src/index.js';
import { deterministicId } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../vectors/paper-baseline-v0.json');
const requesterHead = deterministicId('requester-head');
const providerHead = deterministicId('provider-head');
const nonce = deterministicId('requester-nonce');
const seed = deriveReconciliationSeed(requesterHead, providerHead, nonce);
const common = [deterministicId('common:0'), deterministicId('common:1')];
const providerOnly = [deterministicId('provider:0'), deterministicId('provider:1')];
const receiverOnly = [deterministicId('receiver:0')];
const provider = [...common, ...providerOnly];
const receiver = [...common, ...receiverOnly];
const encoder = new RatelessIbltEncoder(provider, seed, PAPER_BASELINE_V0.mapping);
const decoder = new RatelessIbltDecoder(receiver, seed, PAPER_BASELINE_V0.mapping, 100);
const symbols = [];
for (let index = 0; index < 16; index += 1) {
  const symbol = encoder.produceNext();
  symbols.push(symbol);
  decoder.addProviderSymbol(symbol);
  if (decoder.complete) break;
}
const snapshot = decoder.snapshot();
const fallbackPages = createFallbackPages(provider, 2);
const hexIds = (ids: readonly Uint8Array[]) => ids.map(bytesToHex);
const vector = {
  warning: 'EXPERIMENTAL: not a ProtocolV1 conformance vector',
  referenceProfile: PAPER_BASELINE_V0.profileName,
  requesterHeadId: bytesToHex(requesterHead),
  providerHeadId: bytesToHex(providerHead),
  requesterNonce: bytesToHex(nonce),
  reconciliationSeed: bytesToHex(seed),
  receiverIds: hexIds(receiver),
  providerIds: hexIds(provider),
  receiverRoot: bytesToHex(setCommitment(receiver)),
  providerRoot: bytesToHex(setCommitment(provider)),
  symbols: symbols.map((symbol) => ({
    symbolIndex: symbol.symbolIndex,
    count: symbol.count.toString(),
    idXor: bytesToHex(symbol.idXor),
    checksumXor: bytesToHex(symbol.checksumXor),
    canonicalCbor: bytesToHex(encodeReconciliationSymbolV1(symbol))
  })),
  decode: {
    complete: snapshot.complete,
    providerOnly: hexIds(snapshot.providerOnly),
    receiverOnly: hexIds(snapshot.receiverOnly),
    peelTrace: snapshot.peelTrace
  },
  fallbackPages: fallbackPages.map((page) => ({
    offset: page.offset,
    done: page.done,
    ids: hexIds(page.ids)
  }))
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(vector, null, 2)}\n`);
console.log(outputPath);
