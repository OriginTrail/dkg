import { canonicalDocument } from '../canonical.ts';
import { verifyEvidence } from '../verify.ts';

// Usage: ... | node --experimental-strip-types src/cli/verify.ts
// Reads one evidence document from stdin, writes a canonical verdict to stdout.
// Exit code 0 when the fixture is internally consistent, 1 when it is not, and
// 2 when stdin is not readable JSON. A malformed artifact still yields a full
// verdict document (fail-closed, all checks false) rather than a crash.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

let parsed: unknown;
try {
  parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch (error) {
  process.stderr.write(`verify: stdin is not valid JSON: ${(error as Error).message}\n`);
  process.exit(2);
}

const verdict = verifyEvidence(parsed);
process.stdout.write(canonicalDocument(verdict));
process.exit(verdict.fixtureConsistent ? 0 : 1);
