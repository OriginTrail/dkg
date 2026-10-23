import { createTripleStore } from '../../dist/index.js';
const store = await createTripleStore({ backend: 'oxigraph-persistent', options: { path: process.argv[2] } });
const write = store.insert([{ graph: 'urn:close', subject: 'urn:accepted', predicate: 'urn:value', object: '"small"' }]);
const closing = store.close();
await write;
await closing;
await new Promise(resolve => process.stdout.write('write-and-close-ack\n', resolve));
process.kill(process.pid, 'SIGKILL');
