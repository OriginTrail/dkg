import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { SqliteLiteralBlobOwner } from '../../dist/sqlite-literal-blob-owner.js';
const [directory, mode] = process.argv.slice(2);
const owner = new SqliteLiteralBlobOwner(directory), term = JSON.stringify('last acknowledged é bytes '.repeat(4096));
const hash = createHash('sha256').update(term).digest('hex');
if (mode === 'kill') {
  await owner.write(hash, term);
  writeSync(1, 'durable-blob-ack\n');
  // No RDF mutation or subsequent database write may flush this acknowledgement.
  process.kill(process.pid, 'SIGKILL');
} else {
  assert.equal(await owner.read(hash), term); await owner.close();
  writeSync(1, 'fresh-process-exact-readback\n');
}
