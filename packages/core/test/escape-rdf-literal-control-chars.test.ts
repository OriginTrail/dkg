/**
 * Liveness/regression test for GH #416 -
 * "escapeDkgRdfLiteral covers only ECHAR; non-ECHAR ASCII controls leak through".
 * https://github.com/OriginTrail/dkg/issues/416
 *
 * The canonical RDF literal escaper only handles the seven ECHAR characters
 * (\\ " \n \r \t \f \b). Other ASCII control bytes - NUL (0x00), VT (0x0B),
 * DEL (0x7F), and the 0x01-0x07 / 0x0E-0x1F range - are left raw, producing
 * invalid N-Triples literals at the storage layer. The fix is to UCHAR-encode
 * (`\u00XX`) every control byte not already covered by an ECHAR shortcut.
 *
 * Encoded as `it.fails`: the assertion of correct escaping fails today (bug
 * live). When the escaper is hardened these flip to passing -> `it.fails`
 * turns RED -> drop `.fails` and close #416.
 */
import { describe, expect, it } from 'vitest';
import { escapeDkgRdfLiteral } from '../src/publisher-extension.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = !!process.env.RUN_ISSUE_LIVENESS;


const NUL = String.fromCharCode(0x00);
const VT = String.fromCharCode(0x0b);
const DEL = String.fromCharCode(0x7f);

// Any raw C0 control byte (0x00-0x1F) or DEL (0x7F) left in N-Triples output
// is invalid per the SPARQL/Turtle grammar.
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\x00-\x1F\x7F]/;

describe.runIf(LIVENESS_ENABLED)('GH #416 - escapeDkgRdfLiteral non-ECHAR control bytes', () => {
  it('CONTROL: ECHAR shortcuts still produce canonical short forms', () => {
    expect(escapeDkgRdfLiteral('a"b\nc\td')).toBe('a\\"b\\nc\\td');
  });

  // RDF `\u` UCHAR hex is case-insensitive, so compare lowercased output — a
  // correct fix that emits lowercase hex (``) is just as valid as
  // uppercase and must not keep this red (Codex review on PR #1129).
  it('UCHAR-encodes NUL (0x00) instead of leaving it raw', () => {
    expect(escapeDkgRdfLiteral(`a${NUL}b`).toLowerCase()).toBe('a\\u0000b');
  });

  it('UCHAR-encodes VT (0x0B) instead of leaving it raw', () => {
    expect(escapeDkgRdfLiteral(`a${VT}b`).toLowerCase()).toBe('a\\u000bb');
  });

  it('UCHAR-encodes DEL (0x7F) instead of leaving it raw', () => {
    expect(escapeDkgRdfLiteral(`a${DEL}b`).toLowerCase()).toBe('a\\u007fb');
  });

  it('leaves no raw C0/DEL control byte in the output', () => {
    const out = escapeDkgRdfLiteral(`x${NUL}${VT}${DEL}y`);
    expect(RAW_CONTROL.test(out)).toBe(false);
  });
});
