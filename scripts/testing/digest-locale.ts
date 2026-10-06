import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { Quad } from '../../packages/storage/dist/index.js';

/**
 * Shared by the agent and publisher test suites (one copy: the oracle, the divergent
 * corpus and the process-wide collation mocking must not drift apart).
 *
 * An independent oracle for the SWM public-quads digest: the same framing as
 * production (`sha256` over `[row,row,...]` of `[s, p, o, '']` JSON rows), with
 * the row order supplied by the test. It deliberately does not import any
 * production digest code, so a test written against it also runs on a base
 * commit that predates the ordering gate.
 */
export type DigestRowOrder = 'code-unit' | 'ambient' | string;

export function referenceDigest(quads: readonly Quad[], order: DigestRowOrder): string {
  const rows = quads.map((quad) => JSON.stringify([quad.subject, quad.predicate, quad.object, '']));
  if (order === 'code-unit') rows.sort();
  else if (order === 'ambient') rows.sort((a, b) => a.localeCompare(b));
  else {
    const collator = new Intl.Collator(order);
    rows.sort(collator.compare);
  }
  return `sha256:${createHash('sha256').update(`[${rows.join(',')}]`).digest('hex')}`;
}

function quad(subject: string, object = '"v"'): Quad {
  return { subject, predicate: 'urn:p:value', object, graph: '' };
}

/**
 * Subjects whose serialized rows sort three different ways:
 *   code-unit: 1 A B _ aa b z é
 *   en-US    : _ 1 A aa b B é z
 *   da-DK    : _ 1 A B b é z aa   (`aa` collates as a letter after `z`)
 * Asserted by `assertDivergent` so a host whose ICU collapses them cannot make
 * a test pass vacuously.
 */
export const DIVERGENT_QUADS: readonly Quad[] = Object.freeze([
  'urn:x:aa',
  'urn:x:b',
  'urn:x:B',
  'urn:x:_',
  'urn:x:1',
  'urn:x:A',
  'urn:x:z',
  'urn:x:é',
].map((subject) => Object.freeze(quad(subject))));

export function divergentDigests() {
  return {
    codeUnit: referenceDigest(DIVERGENT_QUADS, 'code-unit'),
    enUS: referenceDigest(DIVERGENT_QUADS, 'en-US'),
    daDK: referenceDigest(DIVERGENT_QUADS, 'da-DK'),
  };
}

/**
 * Make this process behave as if it were started with the given host locale:
 * both `String.prototype.localeCompare` and a locale-less `Intl.Collator` (the
 * two ways the default collator is reached) resolve to `locale`. Explicit
 * locales keep working. Returns the function that undoes it; tests that share a
 * module with other tests call it in a `finally`.
 */
export function useAmbientCollation(locale: string): () => void {
  const RealCollator = Intl.Collator;
  const cache = new Map<string, Intl.Collator>();
  const collatorFor = (locales?: Intl.LocalesArgument): Intl.Collator => {
    const key = String(locales ?? locale);
    let collator = cache.get(key);
    if (!collator) {
      collator = new RealCollator(locales ?? locale);
      cache.set(key, collator);
    }
    return collator;
  };
  const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    that: string,
    locales?: Intl.LocalesArgument,
  ) {
    return collatorFor(locales).compare(this, that);
  });
  const collator = vi.spyOn(Intl, 'Collator').mockImplementation(function (
    locales?: Intl.LocalesArgument,
    options?: Intl.CollatorOptions,
  ) {
    return new RealCollator(locales ?? locale, options);
  } as never);
  return () => {
    localeCompare.mockRestore();
    collator.mockRestore();
  };
}

/** Eight quads on one subject whose rows sort differently under en-US, da-DK and code-unit order. */
export function divergentObjectQuads(
  subject: string,
  predicate = 'urn:p:value',
): Quad[] {
  return ['aa', 'b', 'B', '_', '1', 'A', 'z', 'é'].map((value) => ({
    subject,
    predicate,
    object: `"${value}"`,
    graph: '',
  }));
}
