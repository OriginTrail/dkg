// Installs the global Brotli refusal as the first thing a fresh Node process
// does, as the daemon does at start, then fetches each URL and reports how
// each ended and how many Brotli decoders were created. Node strips the
// module's TypeScript types.
import zlib from 'node:zlib';
import { installGlobalBrotliRefusal } from '../../src/fetch-brotli-refusal.ts';

let decoders = 0;
const createBrotliDecompress = zlib.createBrotliDecompress;
Object.defineProperty(zlib, 'createBrotliDecompress', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: (...args) => {
    decoders += 1;
    return createBrotliDecompress(...args);
  },
});

const install = installGlobalBrotliRefusal();
const results = [];
for (const url of process.argv.slice(2)) {
  try {
    const response = await fetch(url);
    results.push({ status: response.status, body: await response.text() });
  } catch (error) {
    results.push({ error: error.cause?.name ?? error.name });
  }
}
process.stdout.write(JSON.stringify({ install, results, decoders }));
