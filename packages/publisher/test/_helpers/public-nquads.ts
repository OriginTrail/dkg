import {
  quadToNQuad,
  quadsToNQuads,
  type Quad,
} from '@origintrail-official/dkg-storage';

const encoder = new TextEncoder();

export function encodePublicNQuads(quads: readonly Quad[]): Uint8Array {
  return encoder.encode(quadsToNQuads(quads));
}

export function encodedPublicByteLength(quads: readonly Quad[]): number {
  return encodePublicNQuads(quads).length;
}

export function buildPublicQuadsWithByteSize(targetBytes: number, graph = ''): Quad[] {
  const quads: Quad[] = [];
  const maxSafeLiteralBytes = 50_000;
  let currentBytes = 0;

  for (let i = 0; i < 1_000; i++) {
    const subject = `urn:test:oversized-swm:${i}`;
    const predicate = 'http://schema.org/description';
    const emptyLineBytes = encoder.encode(quadToNQuad({
      subject,
      predicate,
      object: '""',
      graph,
    })).length;
    const separatorBytes = quads.length === 0 ? 0 : 1;
    const bytesNeededInsideLiteral =
      targetBytes - currentBytes - separatorBytes - emptyLineBytes;
    const literalBytes =
      bytesNeededInsideLiteral >= 0 && bytesNeededInsideLiteral <= maxSafeLiteralBytes
        ? bytesNeededInsideLiteral
        : maxSafeLiteralBytes;

    const quad: Quad = {
      subject,
      predicate,
      object: `"${'x'.repeat(literalBytes)}"`,
      graph,
    };
    quads.push(quad);

    currentBytes += separatorBytes + encoder.encode(quadToNQuad(quad)).length;
    if (currentBytes >= targetBytes) {
      if (currentBytes !== targetBytes) {
        throw new Error(
          `public N-Quads fixture byte-size drift: expected ${targetBytes}, got ${currentBytes}`,
        );
      }
      const encodedBytes = encodedPublicByteLength(quads);
      if (encodedBytes !== currentBytes) {
        throw new Error(
          `public N-Quads fixture accounting drift: incremental=${currentBytes}, encoded=${encodedBytes}`,
        );
      }
      return quads;
    }
  }

  throw new Error(`failed to build public N-Quads fixture with byte size ${targetBytes}`);
}
