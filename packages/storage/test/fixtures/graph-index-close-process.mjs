import { createTripleStore } from '../../dist/index.js';
const operation = process.argv[3] ?? 'close';
const store = await createTripleStore({ backend: 'oxigraph-persistent', options: { path: process.argv[2] }, graphSetIndex: process.argv[4] !== 'false',
  ...(operation === 'flush' ? { largeLiteralStorage: { directory: `${process.argv[2]}.blobs`, thresholdBytes: 64 } } : {}) });
const write = store.insert([{ graph: 'urn:close', subject: 'urn:accepted', predicate: 'urn:value', object: '"small"' }]);
const closing = operation === 'flush' ? store.flush() : store.close();
await write;
await closing;
await new Promise(resolve => process.stdout.write(`write-and-${operation}-ack\n`, resolve));
process.kill(process.pid, 'SIGKILL');
