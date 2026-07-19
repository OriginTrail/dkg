import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  bytesToHex,
  createFallbackPages,
  createMappingCursor,
  deriveReconciliationSeed,
  emptySymbol,
  encodeReconciliationSymbolV1,
  headForSet,
  idMappingSeed,
  nextMappingIndex,
  setCommitment
} from '../src/reconciliation/index.js';
import { deterministicHeadId, deterministicId, deterministicSet } from '../test/support/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../conformance/vectors/protocol-v1.json');
const requesterHeadId = deterministicHeadId('requester-head');
const providerHeadId = deterministicHeadId('provider-head');
const nonce = deterministicId('requester-nonce');
const seed = deriveReconciliationSeed(requesterHeadId, providerHeadId, nonce);
const common = [deterministicId('common:0'), deterministicId('common:1')];
const providerOnly = [deterministicId('provider:0'), deterministicId('provider:1')];
const receiverOnly = [deterministicId('receiver:0')];
const provider = [...common, ...providerOnly];
const receiver = [...common, ...receiverOnly];
const providerHead = headForSet(providerHeadId, provider);
const symbolEncoder = new RatelessIbltEncoder({
  ids: provider,
  reconciliationSeed: seed,
  algorithm: PAPER_BASELINE_V0.algorithm
});
const symbolDecoder = new RatelessIbltDecoder({
  receiverIds: receiver,
  reconciliationSeed: seed,
  algorithm: PAPER_BASELINE_V0.algorithm,
  limits: { ...PAPER_BASELINE_V0.limits, maximumDecodedDifference: 100 }
});
const symbols = [];
const subtractionStates = [];
for (let index = 0; index < 64 && !symbolDecoder.complete; index += 1) {
  const symbol = symbolEncoder.produceNext();
  symbols.push(symbol);
  symbolDecoder.addProviderSymbol(symbol);
  subtractionStates.push(symbolDecoder.residualSymbols());
}
const snapshot = symbolDecoder.snapshot();
if (!snapshot.complete) throw new Error('conformance fixture did not decode');
const fallbackPages = createFallbackPages(provider, providerHead, 2);
const mappingCursor = createMappingCursor(idMappingSeed(seed, providerOnly[0]));
const mappingIndices = Array.from(
  { length: 16 },
  () => nextMappingIndex(mappingCursor, PAPER_BASELINE_V0.algorithm.mapping)
);
const commitmentInputs = [
  { name: 'empty', ids: [] },
  { name: 'one', ids: [deterministicId('commitment-one')] },
  { name: 'split-300', ids: deterministicSet('commitment-split', 300) }
];
const hexIds = (ids: readonly Uint8Array[]) => ids.map(bytesToHex);
const symbolFixture = (symbol: ReturnType<typeof emptySymbol>) => ({
  symbolIndex: symbol.symbolIndex,
  count: symbol.count.toString(),
  idXor: bytesToHex(symbol.idXor),
  checksumXor: bytesToHex(symbol.checksumXor),
  canonicalCbor: bytesToHex(encodeReconciliationSymbolV1(symbol))
});
const canonicalEmptySymbol = encodeReconciliationSymbolV1(emptySymbol(0));
const vector = {
  schema: 'dkg-wal-protocol-v1-conformance-v1',
  referenceProfile: PAPER_BASELINE_V0.candidateName,
  algorithm: {
    ...PAPER_BASELINE_V0.algorithm,
    mapping: {
      ...PAPER_BASELINE_V0.algorithm.mapping,
      multiplier: `0x${PAPER_BASELINE_V0.algorithm.mapping.multiplier.toString(16)}`
    }
  },
  requesterHeadId: bytesToHex(requesterHeadId),
  providerHeadId: bytesToHex(providerHeadId),
  requesterNonce: bytesToHex(nonce),
  reconciliationSeed: bytesToHex(seed),
  receiverIds: hexIds(receiver),
  providerIds: hexIds(provider),
  receiverRoot: bytesToHex(setCommitment(receiver)),
  providerRoot: bytesToHex(providerHead.objectSetRoot),
  commitmentCases: commitmentInputs.map((input) => ({
    name: input.name,
    ids: hexIds(input.ids),
    root: bytesToHex(setCommitment(input.ids))
  })),
  mappingCase: {
    id: bytesToHex(providerOnly[0]),
    indices: mappingIndices
  },
  symbols: symbols.map(symbolFixture),
  subtractionStates: subtractionStates.map((residual, afterSymbol) => ({
    afterSymbol,
    residual: residual.map(symbolFixture)
  })),
  decode: {
    complete: snapshot.complete,
    providerOnly: hexIds(snapshot.providerOnly),
    receiverOnly: hexIds(snapshot.receiverOnly),
    peelTrace: snapshot.peelTrace
  },
  failureCases: [
    { name: 'empty', canonicalCbor: '', expectedCode: 'MALFORMED_SYMBOL' },
    { name: 'non-canonical-index', canonicalCbor: '841800', expectedCode: 'NON_CANONICAL_SYMBOL' },
    {
      name: 'trailing-byte',
      canonicalCbor: `${bytesToHex(canonicalEmptySymbol)}00`,
      expectedCode: 'TRAILING_BYTES'
    },
    {
      name: 'count-out-of-range',
      canonicalCbor: `84001b80000000000000005820${'00'.repeat(32)}5820${'00'.repeat(32)}`,
      expectedCode: 'INTEGER_OUT_OF_RANGE'
    }
  ],
  fallbackPages: fallbackPages.map((page) => ({
    headId: bytesToHex(page.headId),
    offset: page.offset,
    done: page.done,
    ids: hexIds(page.ids)
  }))
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(vector, null, 2)}\n`);
process.stdout.write(`${outputPath}\n`);
