import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeReconciliationSymbolV1,
  deriveReconciliationSeed,
  encodeReconciliationSymbolV1,
  hexToBytes,
  setCommitment
} from '../src/index.js';

interface VectorSymbol {
  symbolIndex: number;
  count: string;
  idXor: string;
  checksumXor: string;
  canonicalCbor: string;
}

interface ExperimentalVector {
  warning: string;
  requesterHeadId: string;
  providerHeadId: string;
  requesterNonce: string;
  reconciliationSeed: string;
  receiverIds: string[];
  providerIds: string[];
  receiverRoot: string;
  providerRoot: string;
  symbols: VectorSymbol[];
  decode: { complete: boolean };
}

const vector = JSON.parse(
  readFileSync(new URL('../vectors/paper-baseline-v0.json', import.meta.url), 'utf8')
) as ExperimentalVector;

describe('checked-in experimental vector', () => {
  it('recomputes seed, roots, and every canonical symbol tuple', () => {
    expect(vector.warning).toContain('not a ProtocolV1 conformance vector');
    expect(bytesToHex(deriveReconciliationSeed(
      hexToBytes(vector.requesterHeadId, 32),
      hexToBytes(vector.providerHeadId, 32),
      hexToBytes(vector.requesterNonce, 32)
    ))).toBe(vector.reconciliationSeed);
    expect(bytesToHex(setCommitment(vector.receiverIds.map((id) => hexToBytes(id, 32))))).toBe(vector.receiverRoot);
    expect(bytesToHex(setCommitment(vector.providerIds.map((id) => hexToBytes(id, 32))))).toBe(vector.providerRoot);
    for (const fixture of vector.symbols) {
      const decoded = decodeReconciliationSymbolV1(hexToBytes(fixture.canonicalCbor));
      expect(decoded.symbolIndex).toBe(fixture.symbolIndex);
      expect(decoded.count.toString()).toBe(fixture.count);
      expect(bytesToHex(decoded.idXor)).toBe(fixture.idXor);
      expect(bytesToHex(decoded.checksumXor)).toBe(fixture.checksumXor);
      expect(bytesToHex(encodeReconciliationSymbolV1(decoded))).toBe(fixture.canonicalCbor);
    }
    expect(vector.decode.complete).toBe(true);
  });
});
