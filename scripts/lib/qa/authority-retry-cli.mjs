// The wait a shell client makes before a retry of the retryable authority 503.
// argv: the retry (from 0), a file holding the answer's response headers.
// stdout: the wait in seconds. Exit 1: the client stops here.
import { readFileSync } from 'node:fs';
import { authorityRetryDelayMs } from './authority-retry.mjs';

const [retry, headersFile] = process.argv.slice(2);
let headers = '';
try { headers = readFileSync(headersFile, 'utf8'); } catch { /* no headers: the back-off alone decides */ }
// With redirects or interim answers a dump holds several blocks; the last one is the answer's.
const retryAfter = headers.split(/\r?\n/).reduce((found, line) => {
  const header = /^retry-after:(.*)$/i.exec(line);
  return header ? header[1].trim() : line.startsWith('HTTP/') ? undefined : found;
}, undefined);
const delayMs = authorityRetryDelayMs(Number(retry), retryAfter);
if (delayMs === null) process.exitCode = 1;
else console.log(delayMs / 1_000);
