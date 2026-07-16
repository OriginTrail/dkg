/**
 * Minimal OTLP/HTTP collector for local verification (no Docker). Accepts the
 * three signal endpoints, records raw payloads to /tmp/otlp_*.bin, and logs
 * receipts. Protobuf encodes string fields inline as UTF-8, so span/metric
 * names are greppable in the captured bytes.
 */
import http from 'node:http';
import fs from 'node:fs';

for (const s of ['traces', 'metrics', 'logs']) {
  try { fs.rmSync(`/tmp/otlp_${s}.bin`); } catch {}
}
const counts = { traces: 0, metrics: 0, logs: 0, other: 0 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const sig = req.url.includes('/v1/traces') ? 'traces'
      : req.url.includes('/v1/metrics') ? 'metrics'
      : req.url.includes('/v1/logs') ? 'logs' : 'other';
    counts[sig]++;
    if (sig !== 'other') fs.appendFileSync(`/tmp/otlp_${sig}.bin`, buf);
    console.log(`[otlp] ${sig.padEnd(7)} POST ${String(buf.length).padStart(6)}B  (total ${sig}=${counts[sig]})`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-protobuf');
    res.end();
  });
});
server.listen(4318, '127.0.0.1', () => console.log('mock OTLP collector listening on http://127.0.0.1:4318'));
