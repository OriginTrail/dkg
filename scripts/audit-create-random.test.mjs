/**
 * Unit tests for the lexer + hit-finder powering
 * `scripts/audit-create-random.mjs`.
 *
 * Run with:  node --test scripts/audit-create-random.test.mjs
 *
 * The most important case here is the regression test for the
 * string-literal bypass that codex flagged on PR #371: the previous
 * comment-only stripper treated `//` and `/​*` inside string / template
 * literals as real comments, which silently blanked any real
 * `Wallet.createRandom()` call that happened to live on the same line as
 * a string containing those tokens. A security audit that misses real
 * call sites is worse than useless — it provides false assurance.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripCommentsPreservingPositions, findHits } from './audit-create-random.mjs';

describe('stripCommentsPreservingPositions', () => {
  it('blanks // line comments', () => {
    const input = 'let x = 1; // hello\nlet y = 2;';
    const out = stripCommentsPreservingPositions(input);
    assert.equal(out, 'let x = 1;         \nlet y = 2;');
    assert.equal(out.length, input.length);
  });

  it('blanks /* … */ block comments and preserves embedded newlines', () => {
    const input = 'a /* one\ntwo */ b';
    const out = stripCommentsPreservingPositions(input);
    assert.equal(out, 'a       \n       b');
    assert.equal(out.length, input.length);
  });

  it('does NOT enter line-comment mode when // appears inside a "…" string (the PR #371 bypass)', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    // The string contents (incl. the `//`) should be blanked but the
    // `Wallet.createRandom();` after the string MUST remain visible.
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('does NOT enter line-comment mode when // appears inside a \'…\' string', () => {
    const text = "const url = 'http://'; Wallet.createRandom();";
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('does NOT enter block-comment mode when /* appears inside a string', () => {
    const text = 'const s = "/* not a comment"; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('blanks Wallet.createRandom( inside a string literal (no false positive)', () => {
    const text = 'const s = "Wallet.createRandom(arg)"; const z = 1;';
    const out = stripCommentsPreservingPositions(text);
    assert.doesNotMatch(out, /Wallet\.createRandom\(/);
  });

  it('handles escape sequences inside strings (\\" does not close the string early)', () => {
    const text = 'const s = "she said \\"// hi\\""; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('does NOT enter line-comment mode when // appears inside a `…` template literal', () => {
    const text = 'const t = `http://`; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('scans Wallet.createRandom() inside a ${…} template substitution as code', () => {
    const text = 'const t = `value: ${Wallet.createRandom()}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });

  it('handles brace nesting inside template substitutions', () => {
    const text = 'const t = `${({ a: 1 })} ${Wallet.createRandom()}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });

  it('REGRESSION (PR #371 round 2): a `}` inside a string inside a ${...} substitution does NOT close the substitution', () => {
    // Codex caught this exact bypass on the round-1 fix: the flat
    // `state + braceDepth` machine treated the `}` inside `"}"` as the
    // substitution's closing brace, popped back to template-string mode,
    // and blanked the real `Wallet.createRandom()` after it. The
    // stack-based machine pushes dq-string on top of tpl-substitution,
    // so the brace inside the string is just blanked-content.
    const text = 'const t = `${"}" + Wallet.createRandom()}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });

  it('REGRESSION: a `{` inside a string inside a ${...} substitution does NOT inflate the brace counter', () => {
    // Symmetric inverse: `{` inside the inner string must not be counted
    // either, otherwise the substitution would never close and we'd
    // blank everything to EOF (also a bypass — anything after the
    // template would be treated as still-inside-a-template).
    const text = 'const t = `${"{" + Wallet.createRandom()}`; const z = 1;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
    assert.match(out, /const z = 1;/);
  });

  it('REGRESSION: nested template literal inside a substitution is properly re-lexed', () => {
    // `\`outer ${\`inner ${Wallet.createRandom()}\`}\``
    // Inner template is pushed onto the stack on top of the outer
    // substitution; its own ${} pushes another substitution. Real
    // Wallet.createRandom() lives in the inner-inner substitution and
    // must be detected.
    const text = 'const t = `outer ${`inner ${Wallet.createRandom()}`}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });

  it('REGRESSION: // inside a regex literal does NOT start a line comment', () => {
    const text = 'const r = /\\/\\//; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('REGRESSION: // inside a regex literal after return does NOT start a line comment', () => {
    const text = 'function f() { return /\\/\\//; Wallet.createRandom(); }';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('REGRESSION: // inside a regex literal after throw does NOT start a line comment', () => {
    const text = 'function f() { throw /\\/\\//; Wallet.createRandom(); }';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('REGRESSION: /* inside a regex literal does NOT start a block comment', () => {
    const text = 'const r = /\\/\\*/; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('blanks Wallet.createRandom( inside a regex literal (no false positive)', () => {
    const text = 'const r = /Wallet\\.createRandom\\(/; const z = 1;';
    const out = stripCommentsPreservingPositions(text);
    assert.doesNotMatch(out, /Wallet\.createRandom\(/);
    assert.match(out, /const z = 1;/);
  });
});

describe('findHits', () => {
  it('finds a basic Wallet.createRandom() call', () => {
    const hits = findHits('const w = Wallet.createRandom();');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
    assert.match(hits[0].snippet, /Wallet\.createRandom\(\)/);
  });

  it('finds split-line invocations like Wallet\\n.createRandom()', () => {
    const hits = findHits('const w = Wallet\n  .createRandom();');
    assert.equal(hits.length, 1);
  });

  it('finds invocations with block comments between tokens', () => {
    const hits = findHits('Wallet/* nope */.createRandom()');
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 4): finds Wallet import aliases', () => {
    const text = 'import { Wallet as EthersWallet } from "ethers";\nconst w = EthersWallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].identifier, 'EthersWallet');
  });

  it('REGRESSION (PR #371 round 4): follows local Wallet aliases', () => {
    const text = 'const W = Wallet;\nconst w = W.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 4): follows transitive Wallet aliases', () => {
    const text = 'const W = Wallet;\nconst W2 = W;\nconst w = W2.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].identifier, 'W2');
  });

  it('REGRESSION (PR #371 round 4): finds aliases assigned from ethers.Wallet', () => {
    const text = 'const W = ethers.Wallet;\nconst w = W.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 4): finds destructured ethers Wallet aliases', () => {
    const text = 'const { Wallet: EthersWallet } = ethers;\nconst w = EthersWallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].identifier, 'EthersWallet');
  });

  it('REGRESSION (PR #371 round 5): finds optional chaining calls', () => {
    const hits = findHits('const w = Wallet?.createRandom();');
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 5): finds bracket-property calls', () => {
    const hits = findHits('const w = Wallet["createRandom"]();');
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 10): finds template-literal bracket-property calls', () => {
    const hits = findHits('const w = Wallet[`createRandom`]();');
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 7): finds bracket-property calls with comments before the key', () => {
    const hits = findHits("const w = Wallet[/* gap */'createRandom']();");
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 5): finds optional bracket-property calls', () => {
    const hits = findHits("const w = Wallet?.['createRandom']?.();");
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 10): finds optional template-literal bracket-property calls', () => {
    const hits = findHits('const w = Wallet?.[`createRandom`]?.();');
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 7): finds optional bracket-property calls with comments before the key', () => {
    const hits = findHits("const w = Wallet?.[/* gap */'createRandom']?.();");
    assert.equal(hits.length, 1);
  });

  it('REGRESSION (PR #371 round 7): finds destructured Wallet aliases from ethers namespace import aliases', () => {
    const text = [
      'import * as E from "ethers";',
      'const { Wallet: W } = E;',
      'const w = W.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 7): finds Wallet aliases assigned from ethers namespace import aliases', () => {
    const text = [
      'import * as E from "ethers";',
      'const W = E.Wallet;',
      'const w = W.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 10): finds Wallet aliases from named ethers namespace imports', () => {
    const text = [
      'import { ethers as E } from "ethers";',
      'const W = E.Wallet;',
      'const w = W.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 10): finds Wallet aliases from CommonJS ethers namespace requires', () => {
    const text = [
      'const E = require("ethers");',
      'const W = E.Wallet;',
      'const w = W.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].identifier, 'W');
  });

  it('REGRESSION (PR #371 round 10): finds destructured Wallet aliases from CommonJS requires', () => {
    const text = [
      'const { Wallet: W } = require("ethers");',
      'const w = W.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].identifier, 'W');
  });

  it('does NOT report calls inside string literals', () => {
    const hits = findHits('const s = "Wallet.createRandom()";');
    assert.equal(hits.length, 0);
  });

  it('does NOT report calls in line comments', () => {
    const hits = findHits('// Wallet.createRandom()');
    assert.equal(hits.length, 0);
  });

  it('REGRESSION (PR #371): finds calls after a string containing //', () => {
    const text = [
      "const url = 'http://example.com';",
      'const w = Wallet.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}; out: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 2);
  });

  it('REGRESSION (PR #371): finds calls on the SAME line as a string with // inside it', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}; out: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 1);
  });

  it('REGRESSION (PR #371): finds calls after a string containing /*', () => {
    const text = 'const note = "TODO /*";\nWallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });

  it('returns the original-source line snippet (not the blanked version)', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /const url = "http:\/\/"; Wallet\.createRandom\(\);/);
  });

  it('REGRESSION (PR #371): finds calls after a regex containing //', () => {
    const hits = findHits('const r = /\\/\\//; Wallet.createRandom();');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
  });

  it('REGRESSION (PR #371 round 7): finds calls after a keyword-prefixed regex containing //', () => {
    const hits = findHits('function f() { return /\\/\\//; Wallet.createRandom(); }');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
  });
});
