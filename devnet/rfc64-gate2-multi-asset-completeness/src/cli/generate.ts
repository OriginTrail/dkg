import { canonicalDocument } from '../canonical.ts';
import { generateCompleteFixture } from '../generate.ts';

// Usage: node dist/cli/generate.js [count]
// Writes the canonical raw evidence document (single trailing LF) to stdout.
// Pure function of `count`: two invocations produce byte-identical output.
function main(argv: readonly string[]): void {
  const countArg = argv[2] ?? '8';
  const count = Number(countArg);
  if (!Number.isSafeInteger(count) || count < 1) {
    process.stderr.write(`invalid count: ${countArg}\n`);
    process.exit(2);
    return;
  }
  process.stdout.write(canonicalDocument(generateCompleteFixture(count)));
}

main(process.argv);
