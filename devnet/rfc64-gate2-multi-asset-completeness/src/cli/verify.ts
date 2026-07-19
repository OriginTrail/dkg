import { readFileSync } from 'node:fs';
import { canonicalDocument } from '../canonical.ts';
import { verify } from '../verify.ts';

// Usage: node dist/cli/verify.js <raw.json>   (or omit the path to read stdin)
// Writes the canonical verdict document to stdout. Exit code 0 when the fixture
// is complete, 1 when it is rejected (fail-closed), 2 on unreadable input.
// A nonzero exit or a rejected verdict never means "Gate 2 passed".
function main(argv: readonly string[]): void {
  const path = argv[2];
  let text: string;
  try {
    text = path === undefined ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (cause) {
    process.stderr.write(`cannot read raw evidence: ${String(cause)}\n`);
    process.exit(2);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const verdict = verify(parsed);
  process.stdout.write(canonicalDocument(verdict));
  process.exit(verdict.fixtureComplete ? 0 : 1);
}

main(process.argv);
