import { createTripleStore, type Quad } from '../src/index.js';

// The bound's `agentAddress` arrives LOWERCASE (it is unpacked from a packed
// kaId), but the URI segment written by the DKG path may be checksum-cased.
// Every fixture below writes the MIXED-case form into the graph URI and bounds
// on the lowercase form, so a case-sensitive address compare would wrongly drop
// the admitted graph and fail the test.
export const AUTHOR_A_MIXED = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
export const AUTHOR_A = AUTHOR_A_MIXED.toLowerCase();
export const AUTHOR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export const key = (quad: Quad) => `${quad.subject}|${quad.predicate}|${quad.object}`;
export const keys = (quads: Quad[]) => quads.map(key).sort();

export async function seedGraphs(store: Awaited<ReturnType<typeof createTripleStore>>, graphs: string[]): Promise<void> {
  await store.insert(
    graphs.map((graph, i) => ({
      subject: `urn:seed:${i}`,
      predicate: 'urn:p',
      object: '"seed"',
      graph,
    })),
  );
}
