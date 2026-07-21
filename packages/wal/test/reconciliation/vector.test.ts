import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  SymbolWireError,
  applyDecodedDifference,
  bytesToHex,
  createMappingCursor,
  decodeReconciliationSymbolV1,
  deriveReconciliationSeed,
  encodeReconciliationSymbolV1,
  hexToBytes,
  idMappingSeed,
  nextMappingIndex,
  reconciliationHeadId,
  reconciliationSeed,
  setCommitment,
  walObjectId
} from '../../src/reconciliation/index.js';

interface VectorSymbol {
  symbolIndex: number;
  count: string;
  idXor: string;
  checksumXor: string;
  canonicalCbor: string;
}

interface ConformanceVector {
  schema: string;
  requesterHeadId: string;
  providerHeadId: string;
  requesterNonce: string;
  reconciliationSeed: string;
  receiverIds: string[];
  providerIds: string[];
  receiverRoot: string;
  providerRoot: string;
  commitmentCases: Array<{ name: string; ids: string[]; root: string }>;
  mappingCase: { id: string; indices: number[] };
  symbols: VectorSymbol[];
  subtractionStates: Array<{ afterSymbol: number; residual: VectorSymbol[] }>;
  decode: {
    complete: boolean;
    providerOnly: string[];
    receiverOnly: string[];
    peelTrace: Array<{ symbolIndex: number; outcome: string; idHex?: string }>;
  };
  failureCases: Array<{ name: string; canonicalCbor: string; expectedCode: string }>;
  fallbackPages: Array<{ headId: string; offset: number; done: boolean; ids: string[] }>;
}

const vector = JSON.parse(
  readFileSync(new URL('../../conformance/vectors/protocol-v1.json', import.meta.url), 'utf8')
) as ConformanceVector;
const ids = (values: readonly string[]) => values.map((value) => walObjectId(hexToBytes(value, 32)));

describe('ProtocolV1 cross-language conformance vector', () => {
  it('recomputes seed, roots, radix cases, mapping, symbols, decode, and fallback binding', () => {
    expect(vector.schema).toBe('dkg-wal-protocol-v1-conformance-v1');
    const seed = deriveReconciliationSeed(
      reconciliationHeadId(hexToBytes(vector.requesterHeadId, 32)),
      reconciliationHeadId(hexToBytes(vector.providerHeadId, 32)),
      hexToBytes(vector.requesterNonce, 32)
    );
    expect(bytesToHex(seed)).toBe(vector.reconciliationSeed);
    const receiver = ids(vector.receiverIds);
    const provider = ids(vector.providerIds);
    expect(bytesToHex(setCommitment(receiver))).toBe(vector.receiverRoot);
    expect(bytesToHex(setCommitment(provider))).toBe(vector.providerRoot);
    for (const fixture of vector.commitmentCases) {
      expect(bytesToHex(setCommitment(ids(fixture.ids))), fixture.name).toBe(fixture.root);
    }

    const cursor = createMappingCursor(
      idMappingSeed(reconciliationSeed(hexToBytes(vector.reconciliationSeed, 32)), ids([vector.mappingCase.id])[0])
    );
    expect(vector.mappingCase.indices).toEqual(
      vector.mappingCase.indices.map(() => nextMappingIndex(cursor, PAPER_BASELINE_V0.algorithm.mapping))
    );

    const symbolEncoder = new RatelessIbltEncoder({
      ids: provider,
      reconciliationSeed: seed,
      algorithm: PAPER_BASELINE_V0.algorithm
    });
    const symbolDecoder = new RatelessIbltDecoder({
      receiverIds: receiver,
      reconciliationSeed: seed,
      algorithm: PAPER_BASELINE_V0.algorithm
    });
    for (const [index, fixture] of vector.symbols.entries()) {
      const generated = symbolEncoder.produceNext();
      expect(generated.symbolIndex).toBe(fixture.symbolIndex);
      expect(generated.count.toString()).toBe(fixture.count);
      expect(bytesToHex(generated.idXor)).toBe(fixture.idXor);
      expect(bytesToHex(generated.checksumXor)).toBe(fixture.checksumXor);
      expect(bytesToHex(encodeReconciliationSymbolV1(generated))).toBe(fixture.canonicalCbor);
      expect(decodeReconciliationSymbolV1(hexToBytes(fixture.canonicalCbor))).toEqual(generated);
      symbolDecoder.addEncodedProviderSymbol(hexToBytes(fixture.canonicalCbor));
      const residual = symbolDecoder.residualSymbols();
      expect(residual.map((symbol) => ({
        symbolIndex: symbol.symbolIndex,
        count: symbol.count.toString(),
        idXor: bytesToHex(symbol.idXor),
        checksumXor: bytesToHex(symbol.checksumXor),
        canonicalCbor: bytesToHex(encodeReconciliationSymbolV1(symbol))
      }))).toEqual(vector.subtractionStates[index].residual);
    }
    const decoded = symbolDecoder.snapshot();
    expect(decoded.complete).toBe(vector.decode.complete);
    expect(decoded.providerOnly.map(bytesToHex)).toEqual(vector.decode.providerOnly);
    expect(decoded.receiverOnly.map(bytesToHex)).toEqual(vector.decode.receiverOnly);
    expect(decoded.peelTrace).toEqual(vector.decode.peelTrace);
    expect(bytesToHex(setCommitment(applyDecodedDifference(
      receiver,
      decoded.providerOnly,
      decoded.receiverOnly
    )))).toBe(vector.providerRoot);
    for (const failure of vector.failureCases) {
      try {
        decodeReconciliationSymbolV1(hexToBytes(failure.canonicalCbor));
        expect.fail(`${failure.name} unexpectedly decoded`);
      } catch (error) {
        expect(error).toBeInstanceOf(SymbolWireError);
        expect((error as SymbolWireError).code).toBe(failure.expectedCode);
      }
    }
    expect(vector.fallbackPages.every((page) => page.headId === vector.providerHeadId)).toBe(true);
    expect(vector.fallbackPages.flatMap((page) => page.ids)).toEqual([...vector.providerIds].sort());
  });
});
