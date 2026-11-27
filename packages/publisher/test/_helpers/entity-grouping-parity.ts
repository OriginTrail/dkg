import { createHash } from 'node:crypto';
import type { Quad } from '@origintrail-official/dkg-storage';

/** Stable snapshots over 1,000 grouping and 100 full canonical-payload cases. */
export function entityGroupingParityDigests(
  group: (quads: Quad[]) => Map<string, Quad[]>,
  canonical: (quads: Quad[], privateQuads: Quad[]) => unknown,
): { grouping: string; canonical: string } {
  const groupingDigest = createHash('sha256');
  const canonicalDigest = createHash('sha256');
  const quad = (subject: string, object: string): Quad => ({ subject, predicate: 'urn:p', object, graph: 'urn:g' });
  let seed = 0xabc123;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const terms = ['urn:a', 'urn:b', 'urn:c', '_:x', '_:y', '_:z', 'urn:a/.well-known/genid/old'];
  for (let n = 0; n < 1_000; n++) {
    const input = Array.from({ length: Math.floor(random() * 60) }, () =>
      quad(terms[Math.floor(random() * terms.length)], random() < .6 ? terms[Math.floor(random() * terms.length)] : '"literal"'));
    groupingDigest.update(JSON.stringify([...group(input)]) + '\n');
  }
  for (let n = 0; n < 100; n++) {
    const publicQuads: Quad[] = [], privateQuads: Quad[] = [];
    for (let i = 0; i <= n % 10; i++) {
      const root = `urn:root:${i}`;
      publicQuads.push(quad(root, `_:b${i}`), quad(`_:b${i}`, `"value-${n}"`));
      privateQuads.push(quad(root, `"private-${n}"`), quad(`${root}/.well-known/genid/x/.well-known/genid/y`, '"nested"'));
    }
    privateQuads.push(quad('urn:orphan/.well-known/genid/x', '"orphan"'));
    if (n % 2) { publicQuads.reverse(); privateQuads.reverse(); }
    canonicalDigest.update(JSON.stringify(canonical(publicQuads, privateQuads)) + '\n');
  }
  return { grouping: groupingDigest.digest('hex'), canonical: canonicalDigest.digest('hex') };
}
