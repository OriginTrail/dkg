import { describe, expect, it } from 'vitest';

import { isAbsoluteRfc3987IriV1 } from '../src/absolute-rfc3987-iri.js';

describe('RFC 3987 absolute IRI syntax', () => {
  it.each([
    'a:',
    'https://example.org/a/b?x=1#part',
    'https://例え.テスト/路径',
    'urn:example:animal:ferret:nose',
    'did:dkg:otp:20430/0x3333333333333333333333333333333333333333/7',
    'tag:example.org,2026:fixture',
    'mailto:user@example.org',
    'file:///tmp/example',
    'http://[2001:db8::1]/a',
    'http://[::192.0.2.1]/a',
    'http://[v1.fe80]/a',
    'urn:test:%E2%82%AC',
    'urn:test:\u00A0',
  ])('accepts %s', (value) => {
    expect(isAbsoluteRfc3987IriV1(value)).toBe(true);
  });

  it.each([
    '',
    'relative/path',
    '1bad:scheme',
    'http://[',
    'http://[]/',
    'http://[2001:::1]/',
    'http://[2001:db8::1',
    'http://[192.0.2.1::]/',
    'http://[1:192.0.2.1::]/',
    'http://example.org/[x',
    'http://example.org/a\\b',
    'http://example.org/a b',
    'http://example.org/%zz',
    'http://example.org/%0',
    'urn:test:\uFFFF',
    'urn:test:\u{1FFFF}',
    'urn:test:{x}',
    'urn:test:#fragment#again',
    'http://user@@example.org/',
    'http://example.org:bad/',
  ])('rejects %s', (value) => {
    expect(isAbsoluteRfc3987IriV1(value)).toBe(false);
  });

  it('permits RFC3987 private-use code points only in the query component', () => {
    expect(isAbsoluteRfc3987IriV1('urn:test:value?x=\uE000')).toBe(true);
    expect(isAbsoluteRfc3987IriV1('urn:test:\uE000')).toBe(false);
    expect(isAbsoluteRfc3987IriV1('urn:test:value#\uE000')).toBe(false);
  });
});

describe('RFC 3987 authority and path boundaries', () => {
  it.each([
    'a:/', 'a:/one/two', 'a+1.-:/path',
    'http://user:password@example.org:8080/path', 'http://example.org:',
    'http://[::1]:8080/', 'http://[vAF.ab:cd!$&\'()*+,;=]/',
    'http://[1:2:3:4:5:6:7:8]/', 'http://[::ffff:192.0.2.1]/',
  ])('accepts syntax without imposing scheme-specific normalization (%s)', iri => {
    expect(isAbsoluteRfc3987IriV1(iri)).toBe(true);
  });

  it.each([
    'a_b:path', 'a%20:path', 'a/:path',
    'http://user@@host/', 'http://bad%zz@host/', 'http://[::1]suffix/',
    'http://[::1]:x/', 'http://host:abc/', 'http://unbracketed:host:123/',
    'http://[vG.test]/', 'http://[v1.]/', 'http://[v1.invalid^]/',
    'http://[:1:2:3:4:5:6:7]/', 'http://[1:2:3:4:5:6:7:]/',
    'http://[1::2::3]/', 'http://[1:::2]/', 'http://[1:2:3:4:5:6:7:GG]/',
    'http://[1:2:3:4:5:6:7:12345]/', 'http://[192.0.2.1::]/',
    'http://[::192.0.2]/', 'http://[::192.0.2.256]/', 'http://[::192.0.02.1]/',
    'http://[::192.0.x.1]/', 'http://[::192.0..1]/', 'http://[::192.0.2000.1]/',
  ])('rejects malformed schemes, authority delimiters and IP literals (%s)', iri => {
    expect(isAbsoluteRfc3987IriV1(iri)).toBe(false);
  });
});
