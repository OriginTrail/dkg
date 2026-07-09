/**
 * Drive the REAL DKG log-collection pipeline end-to-end against the local
 * stack, exactly as the daemon does:
 *
 *   createLogRedactor()  →  OtlpLogWorker  →  OTel Collector  →  Loki
 *
 * One of the sample records contains a fake private key + mnemonic to prove
 * redaction happens at-source (the collector/Loki never see the secret).
 *
 * Usage (after `docker compose up -d` and a workspace build):
 *   node send-sample-logs.mjs [endpoint] [nodeName] [network]
 *   # defaults: http://localhost:4318/v1/logs  poc-node  devnet
 *   # run twice with different node names to populate the Grafana node selector.
 */
import { createLogRedactor } from '../../packages/core/dist/log-redaction.js';
import { OtlpLogWorker } from '../../packages/node-ui/dist/otlp-log-worker.js';

const endpoint = process.argv[2] || 'http://localhost:4318/v1/logs';
const nodeName = process.argv[3] || 'poc-node';
const network = process.argv[4] || 'devnet';
const redact = createLogRedactor();

const worker = new OtlpLogWorker({
  endpoint,
  token: process.env.OTLP_TOKEN, // bearer token (e.g. when pushing through Alloy)
  network,
  peerId: `12D3KooW-${nodeName}`,
  nodeName, // becomes service.instance.id → the Grafana node-selector label
  version: '10.0.0',
  commit: 'poc0001',
  role: 'core',
  minLevel: 'info',
  flushIntervalMs: 500,
  onError: (m) => console.error('[otlp]', m),
});
worker.start();

const now = () => new Date().toISOString();
const samples = [
  { level: 'info', operationName: 'connect', operationId: 'op-conn-1', module: 'p2p', message: `node up — 8 peers (2 direct / 6 relayed) @ ${now()}` },
  { level: 'info', operationName: 'publish', operationId: 'op-pub-1', module: 'publisher', message: 'published KC 42 root 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef (NOT a secret — should survive)' },
  { level: 'warn', operationName: 'sync', operationId: 'op-sync-1', sourceOperationId: 'op-pub-1', module: 'agent', message: 'peer 12D3KooWxyz slow to ACK, retrying' },
  { level: 'error', operationName: 'query', operationId: 'op-qry-1', module: 'query', message: 'SPARQL timeout after 30s' },
  // SECRET — must be redacted before it leaves the node:
  { level: 'info', operationName: 'init', operationId: 'op-init-1', module: 'wallet', message: 'loaded operationalWalletPrivateKey=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef mnemonic="legal winner thank year wave sausage worth useful legal winner thank yellow"' },
];

for (const s of samples) worker.push(redact(s));

console.log(`Pushed ${samples.length} records (1 containing a secret, pre-redacted) → ${endpoint}`);
console.log('Flushing…');

// Allow a couple of flush cycles, then stop (final flush) and exit.
setTimeout(() => {
  worker.stop();
  console.log('Done. In Grafana (http://localhost:3000) → Explore → Loki, query:');
  console.log('  {service_name="dkg-node"}');
  console.log('Confirm the wallet line shows [REDACTED] (no 0xdeadbeef…, no mnemonic words).');
  setTimeout(() => process.exit(0), 300);
}, 1500);
