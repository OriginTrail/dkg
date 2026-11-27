import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A store that holds read graphs refuses a SPARQL UPDATE that does not declare the graphs it
// writes (`writtenGraphs`). This census reads the production sources that write through a
// TripleStore and fails on an update call that names no `writtenGraphs`. It lives in the cli
// package because the cli lane runs on a change to any of the packages it reads.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = ['agent', 'publisher', 'cli'];

/** Update calls that only forward their caller's options, which carry the declaration. */
const FORWARDERS = new Map([
  ['packages/agent/src/internal/context-graph-cache-invalidating-store.ts', 'forwards the caller\'s options unchanged'],
]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * The source with comments and the contents of string and template literals blanked, the code in
 * `${…}` kept, and every line where it was: only code is scanned for calls.
 */
function codeOnly(source: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < Math.min(to, source.length); k += 1) out.push(source[k] === '\n' ? '\n' : ' ');
  };
  const template = (): void => {
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') { blank(i, i + 2); i += 2; continue; }
      if (char === '`') { out.push('`'); i += 1; return; }
      if (char === '$' && source[i + 1] === '{') {
        out.push('$', '{'); i += 2;
        code(true);
        if (i < source.length) { out.push('}'); i += 1; }
        continue;
      }
      blank(i, i + 1); i += 1;
    }
  };
  const code = (inInterpolation: boolean): void => {
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      const next = source[i + 1];
      if (inInterpolation && char === '{') depth += 1;
      if (inInterpolation && char === '}' && depth-- === 0) return;
      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end < 0 ? source.length : end;
        blank(i, stop); i = stop; continue;
      }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end < 0 ? source.length : end + 2;
        blank(i, stop); i = stop; continue;
      }
      if (char === '"' || char === "'") {
        const start = i;
        out.push(char); i += 1;
        while (i < source.length && source[i] !== char && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
        blank(start + 1, i);
        if (i < source.length) { out.push(source[i]!); i += 1; }
        continue;
      }
      if (char === '`') { out.push('`'); i += 1; template(); continue; }
      out.push(char!); i += 1;
    }
  };
  code(false);
  return out.join('');
}

/** The text of a call's arguments, from the index just after its opening parenthesis. */
function argumentsFrom(source: string, start: number): string {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return source.slice(start, index);
  }
  throw new Error(`Unbalanced call at ${start}`);
}

interface UpdateCall { readonly file: string; readonly line: number; readonly call: string; readonly args: string }

/** Calls of `update` on a store (`store.update(`, `this.store.update!(`, `innerStore.update!(`) and of the update helper. */
function updateCalls(): UpdateCall[] {
  const calls: UpdateCall[] = [];
  const pattern = /(?:\b[\w$.]*[sS]tore\s*!?\s*\??\.\s*update\s*!?|\btryUpdateWithTouchedGraphs)\s*\(/g;
  for (const name of PACKAGES) {
    for (const path of sources(join(REPO_ROOT, 'packages', name, 'src'))) {
      const source = codeOnly(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(pattern)) {
        const at = match.index!;
        // A declaration of the helper is not a call of it.
        if (/function\s+$/.test(source.slice(Math.max(0, at - 20), at))) continue;
        calls.push({
          file: relative(REPO_ROOT, path),
          line: source.slice(0, at).split('\n').length,
          call: match[0].replace(/\s+/g, ''),
          args: argumentsFrom(source, at + match[0].length),
        });
      }
    }
  }
  return calls;
}

describe('SPARQL updates in agent, publisher and cli', () => {
  const calls = updateCalls();

  it('are found by the census', () => {
    // A scan that matches nothing would pass every check below.
    expect(calls.filter(call => call.call.startsWith('tryUpdateWithTouchedGraphs')).length).toBeGreaterThanOrEqual(10);
    expect(calls.filter(call => !call.call.startsWith('tryUpdateWithTouchedGraphs')).length).toBeGreaterThanOrEqual(10);
  });

  it('each declare the graphs they write', () => {
    const undeclared = calls
      .filter(call => !FORWARDERS.has(call.file) && !/\bwrittenGraphs\b/.test(call.args))
      .map(call => `${call.file}:${call.line} ${call.call}`);
    expect(undeclared).toEqual([]);
  });

  it('leave no forwarder without an update to forward', () => {
    for (const file of FORWARDERS.keys()) expect(calls.some(call => call.file === file), file).toBe(true);
  });
});
