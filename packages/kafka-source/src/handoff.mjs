import { createHash } from 'node:crypto';
import { assetIdentity } from './asset.mjs';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validateHandoff(source) {
  const h = source.handoff;
  if (!h) return;
  if (Object.keys(h).some(key => !['url', 'tokenEnv', 'accountId', 'nodeId', 'sourceRevision', 'configurationDigest'].includes(key)) ||
    !id.test(h.accountId ?? '') || !id.test(h.nodeId ?? '') || !id.test(source.id ?? '') ||
    !Number.isSafeInteger(h.sourceRevision) || h.sourceRevision < 1 || !/^[a-f0-9]{64}$/.test(h.configurationDigest ?? '') ||
    !envName.test(h.tokenEnv ?? '') || !source.registryRef?.descriptor.providerIri || source.mapping?.length)
    throw new Error('KAFKA_HANDOFF_CONFIG_INVALID');
  let url;
  try { url = new URL(h.url); } catch { throw new Error('KAFKA_HANDOFF_ENDPOINT_INVALID'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/spike/pharmagenesis/source-handoffs')
    throw new Error('KAFKA_HANDOFF_ENDPOINT_INVALID');
}
export function evidenceRef(source, record, receipt) {
  const { registryRef: r, handoff: h } = source;
  return {
    version: 1, accountId: h.accountId, nodeId: h.nodeId, sourceId: source.id,
    sourceRevision: h.sourceRevision, configurationDigest: h.configurationDigest,
    recordId: assetIdentity(source, record),
    registry: { ual: r.ual, contextGraphId: r.contextGraphId, descriptorHash: r.descriptorHash,
      ...(r.publisherIri ? { publisherIri: r.publisherIri } : {}) },
    providerIri: r.descriptor.providerIri, agentAddress: source.agentAddress.toLowerCase(),
    contextGraphId: source.contextGraphId, clusterId: source.clusterId, topic: record.topic,
    partition: record.partition, offset: record.offset, timestamp: record.timestamp ?? null,
    fetchedAt: record.fetchedAt,
    payloadDigest: createHash('sha256').update(record.valueBase64 === null ? Buffer.alloc(0) : Buffer.from(record.valueBase64, 'base64')).digest('hex'),
    tombstone: record.valueBase64 === null,
    ...(r.descriptor.schemaIri ? { schemaIri: r.descriptor.schemaIri } : {}),
    receipt: { name: receipt.name, assertion: receipt.assertion, assertionGraph: receipt.assertionGraph },
  };
}

/** Bounded, restart-durable retry. A failed handoff never reruns the DKG write. */
export async function drainHandoffs(source, journal, send = fetch, now = Date.now) {
  if (!source.handoff) return;
  const h = source.handoff, token = process.env[h.tokenEnv];
  if (!token || token.length < 32 || token.length > 512 || /\s/.test(token)) throw new Error('KAFKA_HANDOFF_CREDENTIAL_REQUIRED');
  for (const item of journal.pendingHandoffs(now(), 10)) {
    let retryAt = now() + Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6));
    let code = 'KAFKA_HANDOFF_UNAVAILABLE', blocked = false;
    try {
      const response = await send(h.url, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: item.body, signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        // Bound response bytes; never accept an HTTP success without the matching durable receipt.
        const reader = response.body?.getReader(); const chunks = []; let length = 0;
        try {
          if (reader) for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength; if (length > 4096) throw new Error('oversized'); chunks.push(value);
          }
        } finally { await reader?.cancel().catch(() => {}); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.accepted === true && body.recordId === item.id && body.status === 'awaiting-workflow') {
          journal.handoffAccepted(item.id); continue;
        }
        code = 'KAFKA_HANDOFF_RECEIPT_INVALID';
      } else {
        if ([400, 401, 403, 404, 409, 415].includes(response.status)) { blocked = true; code = 'KAFKA_HANDOFF_REVIEW_REQUIRED'; }
        if (response.status === 429) {
          const after = response.headers.get('retry-after');
          if (after) {
            const deadline = /^\d+$/.test(after) ? now() + Number(after) * 1000 : Date.parse(after);
            if (Number.isFinite(deadline)) retryAt = Math.max(retryAt, deadline);
          }
        }
        await response.body?.cancel().catch(() => {});
      }
    } catch { /* Store no transport exception, payload, endpoint or credential. */ }
    journal.handoffFailed(item.id, code, retryAt, blocked);
    break;
  }
}
