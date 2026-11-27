import { describe, expect, it } from 'vitest';
import { isAbsoluteRfc3987IriV1 } from '@origintrail-official/dkg-rdf-utils';
import { isAbsoluteRfc3987IriV1 as fromSource } from '../src/absolute-rfc3987-iri.js';

// Core publishes every `dist/*` module, so moving one out of core breaks a
// deep import of it unless the old path re-exports the new home.
describe('former core module paths', () => {
  it('keeps dist/absolute-rfc3987-iri.js resolving to the rdf-utils validator', async () => {
    const published = await import('@origintrail-official/dkg-core/dist/absolute-rfc3987-iri.js');
    expect(published.isAbsoluteRfc3987IriV1).toBe(isAbsoluteRfc3987IriV1);
    expect(fromSource).toBe(isAbsoluteRfc3987IriV1);
    expect(published.isAbsoluteRfc3987IriV1('urn:example:x')).toBe(true);
    expect(published.isAbsoluteRfc3987IriV1('relative/path')).toBe(false);
  });
});
