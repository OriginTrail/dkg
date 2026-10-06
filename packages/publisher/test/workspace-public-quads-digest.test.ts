import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_DIGEST_ORDERING_ENV,
  describeWorkspaceDigestConfiguration,
  resolveWorkspaceDigestOrdering,
  workspacePublicQuadsAcceptedDigests,
  workspacePublicQuadsCodeUnitDigest,
  workspacePublicQuadsDigest,
  workspacePublicQuadsDigestCandidates,
  workspacePublicQuadsDigestMatches,
  workspacePublicQuadsDigestWithOrdering,
  workspacePublicQuadsLegacyDigest,
} from '../src/workspace-public-quads-digest.js';
import {
  DIVERGENT_QUADS,
  divergentDigests,
  referenceDigest,
  useAmbientCollation,
} from '../../../scripts/testing/digest-locale.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Pinned so an accidental change of the canonical form is caught. */
const PINNED_CODE_UNIT_DIGEST =
  'sha256:7405b90c62a0e3d89607e65cee0c829fde0c455c5fc80f69fe2d218566d05867';

describe('the divergent fixture', () => {
  it('sorts three different ways, so no test below can pass vacuously', () => {
    const { codeUnit, enUS, daDK } = divergentDigests();
    expect(new Set([codeUnit, enUS, daDK]).size).toBe(3);
  });
});

describe('workspacePublicQuadsCodeUnitDigest', () => {
  it('matches the independent code-unit oracle', () => {
    expect(workspacePublicQuadsCodeUnitDigest(DIVERGENT_QUADS)).toBe(divergentDigests().codeUnit);
  });

  it('is a pinned value (algorithm drift guard)', () => {
    expect(workspacePublicQuadsCodeUnitDigest(DIVERGENT_QUADS)).toBe(PINNED_CODE_UNIT_DIGEST);
  });

  it('does not depend on the ambient collator or on input order', () => {
    const expected = workspacePublicQuadsCodeUnitDigest(DIVERGENT_QUADS);
    for (const locale of ['da-DK', 'sv-SE', 'tr-TR', 'de-DE']) {
      useAmbientCollation(locale);
      expect(workspacePublicQuadsCodeUnitDigest(DIVERGENT_QUADS)).toBe(expected);
      expect(workspacePublicQuadsCodeUnitDigest([...DIVERGENT_QUADS].reverse())).toBe(expected);
      vi.restoreAllMocks();
    }
  });

  it('hashes every term as given and ignores the graph', () => {
    const a: Quad = { subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g:1' };
    const b: Quad = { subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g:2' };
    expect(workspacePublicQuadsCodeUnitDigest([a])).toBe(workspacePublicQuadsCodeUnitDigest([b]));
    expect(workspacePublicQuadsCodeUnitDigest([a]))
      .not.toBe(workspacePublicQuadsCodeUnitDigest([{ ...a, object: '"O"' }]));
  });

  it('keeps duplicate rows and the empty snapshot well defined', () => {
    const one = DIVERGENT_QUADS[0]!;
    expect(workspacePublicQuadsCodeUnitDigest([one, one])).toBe(referenceDigest([one, one], 'code-unit'));
    expect(workspacePublicQuadsCodeUnitDigest([])).toBe(referenceDigest([], 'code-unit'));
  });
});

describe('workspacePublicQuadsLegacyDigest', () => {
  it('is the pre-gate own-locale digest and follows the process locale', () => {
    const { enUS, daDK } = divergentDigests();
    expect(workspacePublicQuadsLegacyDigest(DIVERGENT_QUADS)).toBe(enUS);
    useAmbientCollation('da-DK');
    expect(workspacePublicQuadsLegacyDigest(DIVERGENT_QUADS)).toBe(daDK);
  });
});

describe('the producer gate', () => {
  it('defaults to the legacy own-locale digest, byte for byte', () => {
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(divergentDigests().enUS);
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(referenceDigest(DIVERGENT_QUADS, 'ambient'));
  });

  it('emits the locale-independent digest once the operator opts in', () => {
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    const { codeUnit } = divergentDigests();
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(codeUnit);
    // Identical on a host with another locale: the point of the change.
    useAmbientCollation('da-DK');
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(codeUnit);
  });

  it('is decided per call, so a test or an operator can flip it without a restart', () => {
    const { codeUnit, enUS } = divergentDigests();
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(codeUnit);
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'locale');
    expect(workspacePublicQuadsDigest(DIVERGENT_QUADS)).toBe(enUS);
  });

  it.each([
    [undefined, 'locale'],
    ['', 'locale'],
    ['locale', 'locale'],
    ['  LOCALE ', 'locale'],
    ['code-unit', 'code-unit'],
    [' Code-Unit ', 'code-unit'],
  ] as const)('resolves %j to %s', (raw, expected) => {
    expect(resolveWorkspaceDigestOrdering(raw)).toBe(expected);
  });

  it('keeps the legacy ordering for an unrecognised value and says so once', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    expect(resolveWorkspaceDigestOrdering('codeunit')).toBe('locale');
    expect(resolveWorkspaceDigestOrdering('codeunit')).toBe('locale');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(String(emit.mock.calls[0]![0])).toContain(WORKSPACE_DIGEST_ORDERING_ENV);
    expect(resolveWorkspaceDigestOrdering('utf8')).toBe('locale');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('exposes the explicit ordering entry point', () => {
    const { codeUnit, enUS } = divergentDigests();
    expect(workspacePublicQuadsDigestWithOrdering(DIVERGENT_QUADS, 'code-unit')).toBe(codeUnit);
    expect(workspacePublicQuadsDigestWithOrdering(DIVERGENT_QUADS, 'locale')).toBe(enUS);
  });
});

describe('workspacePublicQuadsDigestMatches', () => {
  const { codeUnit, enUS, daDK } = divergentDigests();

  it('accepts the code-unit and the own-locale digest on an en-US node', () => {
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, codeUnit)).toBe(true);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, enUS)).toBe(true);
  });

  it('accepts the code-unit, the own-locale and the pinned en-US digest on a da-DK node', () => {
    useAmbientCollation('da-DK');
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, daDK)).toBe(true);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, codeUnit)).toBe(true);
    // The en-US majority's legacy digests still verify on a differently
    // configured node: this is what stops a da-DK operator being locked out.
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, enUS)).toBe(true);
  });

  it('accepts every form on a node that has opted into code-unit digests', () => {
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, codeUnit)).toBe(true);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, enUS)).toBe(true);
  });

  it('does not weaken the integrity check: other content, other shapes and near misses fail', () => {
    const tampered = [...DIVERGENT_QUADS.slice(1), { ...DIVERGENT_QUADS[0]!, object: '"tampered"' }];
    const dropped = DIVERGENT_QUADS.slice(1);
    for (const expected of [codeUnit, enUS]) {
      expect(workspacePublicQuadsDigestMatches(tampered, expected)).toBe(false);
      expect(workspacePublicQuadsDigestMatches(dropped, expected)).toBe(false);
    }
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, '')).toBe(false);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, 'sha256:abc')).toBe(false);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, codeUnit.toUpperCase())).toBe(false);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, `sha256:${'0'.repeat(64)}`)).toBe(false);
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, undefined as never)).toBe(false);
  });

  it('does not compute a digest for a malformed expectation', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, 'not-a-digest')).toBe(false);
    expect(stringify).not.toHaveBeenCalled();
  });

  it('stops at the first matching form, so the common case costs one digest', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, enUS)).toBe(true);
    // Rows are serialised once, however many forms are tried.
    expect(stringify).toHaveBeenCalledTimes(DIVERGENT_QUADS.length);
  });

  it('serialises the rows once even when every form is tried', () => {
    useAmbientCollation('da-DK');
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(workspacePublicQuadsDigestMatches(DIVERGENT_QUADS, `sha256:${'1'.repeat(64)}`)).toBe(false);
    expect(stringify).toHaveBeenCalledTimes(DIVERGENT_QUADS.length);
  });
});

describe('workspacePublicQuadsDigestCandidates', () => {
  const { codeUnit, enUS, daDK } = divergentDigests();

  it('offers this node\'s own form first: legacy by default', () => {
    expect([...workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS)]).toEqual([enUS, codeUnit]);
  });

  it('offers the code-unit form first once the gate is on', () => {
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    expect([...workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS)]).toEqual([codeUnit, enUS]);
  });

  it('adds the pinned en-US form when the ambient locale is another one', () => {
    useAmbientCollation('da-DK');
    expect([...workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS)]).toEqual([daDK, codeUnit, enUS]);
  });

  it('is lazy: nothing is sorted or hashed until a candidate is requested', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const candidates = workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS);
    expect(stringify).not.toHaveBeenCalled();
    candidates.next();
    expect(stringify).toHaveBeenCalledTimes(DIVERGENT_QUADS.length);
  });

  it('skips the en-US form when the runtime has no usable Intl.Collator', () => {
    useAmbientCollation('da-DK');
    const Real = Intl.Collator;
    vi.spyOn(Intl, 'Collator').mockImplementation(function (locales?: string | string[]) {
      // The ambient probe still works; building the pinned en-US collator fails.
      if (locales === 'en-US') throw new RangeError('unsupported');
      return new Real(locales ?? 'da-DK');
    } as never);
    expect([...workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS)]).toEqual([daDK, codeUnit]);
  });

  it('treats an ambient probe failure as "not en-US" and still yields the pinned form', () => {
    const Real = Intl.Collator;
    let probes = 0;
    vi.spyOn(Intl, 'Collator').mockImplementation(function (locales?: string | string[]) {
      if (locales === undefined && probes++ === 0) throw new RangeError('no default collator');
      return new Real(locales ?? 'en-US');
    } as never);
    // The ambient probe throws once, so the node is treated as "not en-US" and
    // the pinned en-US form is still offered (it equals the own-locale form here).
    expect([...workspacePublicQuadsDigestCandidates(DIVERGENT_QUADS)]).toEqual([enUS, codeUnit, enUS]);
  });
});

describe('workspacePublicQuadsAcceptedDigests', () => {
  const { codeUnit, enUS, daDK } = divergentDigests();

  it('lists every accepted form once, for validation evidence', () => {
    expect(workspacePublicQuadsAcceptedDigests(DIVERGENT_QUADS)).toEqual([enUS, codeUnit]);
    useAmbientCollation('da-DK');
    expect(workspacePublicQuadsAcceptedDigests(DIVERGENT_QUADS)).toEqual([daDK, codeUnit, enUS]);
  });

  it('collapses forms that coincide for content whose order every collator agrees on', () => {
    const single = [DIVERGENT_QUADS[0]!];
    const accepted = workspacePublicQuadsAcceptedDigests(single);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toBe(referenceDigest(single, 'code-unit'));
  });
});

describe('describeWorkspaceDigestConfiguration', () => {
  it('reports the write ordering and the collator locale on one greppable line', () => {
    expect(describeWorkspaceDigestConfiguration()).toMatch(/^SWM public-quads digest ordering=locale collatorLocale=en-US /u);
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    useAmbientCollation('da-DK');
    expect(describeWorkspaceDigestConfiguration())
      .toMatch(/^SWM public-quads digest ordering=code-unit collatorLocale=da(?:-DK)? /u);
  });

  it('still reports on a runtime without a usable Intl.Collator', () => {
    vi.spyOn(Intl, 'Collator').mockImplementation(function () {
      throw new RangeError('no collator');
    } as never);
    expect(describeWorkspaceDigestConfiguration()).toContain('collatorLocale=unknown');
  });
});
