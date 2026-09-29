import type { Quad } from '@origintrail-official/dkg-storage';

const encoder = new TextEncoder();

export function serializePublicQuad(quad: Quad): string {
  return `<${quad.subject}> <${quad.predicate}> ${
    quad.object.startsWith('"') ? quad.object : `<${quad.object}>`
  } <${quad.graph}> .`;
}

export function encodePublicNQuads(quads: readonly Quad[]): Uint8Array {
  return encoder.encode(quads.map(serializePublicQuad).join('\n'));
}

export function encodedPublicByteLength(quads: readonly Quad[]): number {
  return encodePublicNQuads(quads).length;
}

export function buildPublicQuadsWithByteSize(targetBytes: number, graph = ''): Quad[] {
  const quads: Quad[] = [];
  const maxSafeLiteralBytes = 50_000;

  for (let i = 0; i < 1_000; i++) {
    const subject = `urn:test:oversized-swm:${i}`;
    const predicate = 'http://schema.org/description';
    const emptyLine = serializePublicQuad({
      subject,
      predicate,
      object: '""',
      graph,
    });
    const currentBytes = encodedPublicByteLength(quads);
    const separatorBytes = quads.length === 0 ? 0 : 1;
    const bytesNeededInsideLiteral =
      targetBytes - currentBytes - separatorBytes - encoder.encode(emptyLine).length;
    const literalBytes =
      bytesNeededInsideLiteral >= 0 && bytesNeededInsideLiteral <= maxSafeLiteralBytes
        ? bytesNeededInsideLiteral
        : maxSafeLiteralBytes;

    quads.push({
      subject,
      predicate,
      object: `"${'x'.repeat(literalBytes)}"`,
      graph,
    });

    const size = encodedPublicByteLength(quads);
    if (size >= targetBytes) {
      if (size !== targetBytes) {
        throw new Error(
          `public N-Quads fixture byte-size drift: expected ${targetBytes}, got ${size}`,
        );
      }
      return quads;
    }
  }

  throw new Error(`failed to build public N-Quads fixture with byte size ${targetBytes}`);
}
