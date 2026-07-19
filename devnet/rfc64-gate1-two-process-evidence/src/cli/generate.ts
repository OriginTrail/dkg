import { canonicalDocument } from '../canonical.ts';
import { generateConsistentEvidence } from '../generate.ts';

// Usage: node --experimental-strip-types src/cli/generate.ts [quadCount]
// Writes one canonical evidence document to stdout. Pure function of the
// argument: two runs with the same count are byte-identical.
const raw = process.argv[2] ?? '8';
const quadCount = Number(raw);
if (!Number.isSafeInteger(quadCount) || quadCount < 1) {
  process.stderr.write(`generate: quadCount must be a safe integer >= 1, got "${raw}"\n`);
  process.exit(2);
}
process.stdout.write(canonicalDocument(generateConsistentEvidence(quadCount)));
