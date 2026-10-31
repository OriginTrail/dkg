import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptorHash } from '@origintrail-official/kafka-plugin/registry';
import { Journal } from '../src/journal.mjs';
import { evidenceRef, validateHandoff, drainHandoffs } from '../src/handoff.mjs';
import { kafkaTls } from '../src/tls.mjs';
import { createHandler } from '../src/handler.mjs';
import { runSourceWorkerOnce } from '../../agent/src/source-worker.ts';
import { hash, buildAsset } from '../src/asset.mjs';
import { enrollKafkaSource } from '../src/registry.mjs';

const dirs = [], journals = [];
afterEach(async () => {
  vi.unstubAllEnvs(); for (const j of journals.splice(0)) j.close();
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
async function directory() { const d = await mkdtemp(join(tmpdir(), 'kafka-handoff-')); dirs.push(d); return d; }
const descriptor = { name: 'Example stream', kafkaBootstrapUrl: 'kafkas://broker.example:9094',
  kafkaTopicName: 'measurements', dataFormat: 'JSON', providerIri: 'urn:provider:example', clusterId: 'cluster-1' };
const registry = { version: 1, ual: 'did:dkg:registry:1', contextGraphId: 'catalog', descriptor,
  descriptorHash: descriptorHash(descriptor) };
const source = enrollKafkaSource(registry, { id: 'source-a', groupId: 'consumer-group-a', fromBeginning: false,
  agentAddress: '0x' + 'a'.repeat(40), contextGraphId: 'private-graph-a',
  handoff: { accountId: 'account-a', nodeId: 'node-a', sourceRevision: 1,
    configurationDigest: 'd'.repeat(64), url: 'https://workflows.example/spike/pharmagenesis/source-handoffs', tokenEnv: 'TEST_HANDOFF_TOKEN' } });
const record = { topic: 'measurements', partition: 0, offset: '9007199254740993', timestamp: '1700000000000',
  keyBase64: null, valueBase64: Buffer.from('not-json').toString('base64'), headers: { repeated: ['YQ==', 'Yg=='] }, fetchedAt: '2026-10-30T00:00:00.000Z' };
const receipt = { name: buildAsset(source, record).name, assertion: 'sealed-1', assertionGraph: 'urn:sealed:1', reused: false };
const ref = evidenceRef(source, record, receipt);
test.each(['urn:provider:example', 'https://provider.example/organization/b'])('preserves configured provider attribution %s without domain metadata', providerIri => {
  const selected = { ...descriptor, providerIri };
  const entry = { ...registry, descriptor: selected, descriptorHash: descriptorHash(selected) };
  const enrolled = enrollKafkaSource(entry, {
    id: 'source-b', groupId: 'consumer-group-b', fromBeginning: false,
    agentAddress: source.agentAddress, contextGraphId: 'private-graph-b',
    handoff: { ...source.handoff, nodeId: 'node-b' },
  });
  validateHandoff(enrolled);
  expect(evidenceRef(enrolled, record, receipt)).toMatchObject({
    providerIri, sourceId: 'source-b', nodeId: 'node-b', contextGraphId: 'private-graph-b',
    registry: { descriptorHash: descriptorHash(selected) },
  });
});
async function journal() { const path = join(await directory(), 'journal.sqlite'); const j = new Journal(path, 'test'); journals.push(j); return { j, path }; }
function enqueue(j, value = ref) {
  const row = j.stage(record, hash(record), receipt.name);
  j.verified(row.position, receipt, value);
}
test('handoff retains provenance and only references sealed bytes, including non-JSON and tombstones', () => {
  validateHandoff(source);
  expect(ref.offset).toBe(record.offset); expect(ref.receipt).not.toHaveProperty('reused');
  expect(JSON.stringify(ref)).not.toContain('not-json'); expect(ref).not.toHaveProperty('valueBase64');
  expect(evidenceRef(source, { ...record, valueBase64: null }, receipt).tombstone).toBe(true);
  expect(() => validateHandoff({ ...source, mapping: [{ field: 'x', predicate: 'urn:x' }] })).toThrow('KAFKA_HANDOFF_CONFIG_INVALID');
});
test.each(['http://remote.example/spike/pharmagenesis/source-handoffs', 'https://user:secret@workflows.example/spike/pharmagenesis/source-handoffs',
  'https://workflows.example/other', 'https://workflows.example/spike/pharmagenesis/source-handoffs?token=secret'])('rejects unsafe handoff destination %s', url => {
  expect(() => validateHandoff({ ...source, handoff: { ...source.handoff, url } })).toThrow('KAFKA_HANDOFF_ENDPOINT_INVALID');
});
test('receipt and outbox insert are atomic, identity conflict rolls back', async () => {
  const { j } = await journal(); enqueue(j); enqueue(j);
  expect(j.handoffBacklog()).toBe(1);
  expect(() => enqueue(j, { ...ref, payloadDigest: 'e'.repeat(64) })).toThrow('KAFKA_HANDOFF_IDENTITY_CHANGED');
  expect(j.pendingHandoffs(Date.now(), 10)[0].body).toBe(JSON.stringify(ref));
});
test('failed delivery survives restart and successful replay requires the exact durable acceptance', async () => {
  vi.stubEnv('TEST_HANDOFF_TOKEN', 'synthetic-token-never-use-outside-this-test');
  const { j, path } = await journal(); enqueue(j);
  await drainHandoffs(source, j, async () => { throw new Error('credential-do-not-log'); }, () => 1000);
  expect(j.pendingHandoffs(1999, 10)).toEqual([]);
  j.close(); journals.splice(journals.indexOf(j), 1);
  const restored = new Journal(path, 'test'); journals.push(restored);
  const send = vi.fn(async (_url, options) => {
    expect(options.redirect).toBe('error'); expect(options.body).toBe(JSON.stringify(ref));
    return Response.json({ accepted: true, recordId: ref.recordId, status: 'awaiting-workflow' });
  });
  await drainHandoffs(source, restored, send, () => 2000);
  expect(send).toHaveBeenCalledTimes(1); expect(restored.handoffBacklog()).toBe(0);
  enqueue(restored); expect(restored.handoffBacklog()).toBe(0);
});
test('HTTP success without matching receipt remains pending; auth errors require review', async () => {
  vi.stubEnv('TEST_HANDOFF_TOKEN', 'synthetic-token-never-use-outside-this-test');
  const { j } = await journal(); enqueue(j);
  await drainHandoffs(source, j, async () => Response.json({ accepted: true, recordId: 'wrong' }), () => 0);
  expect(j.handoffBacklog()).toBe(1);
  await drainHandoffs(source, j, async () => new Response(null, { status: 403 }), () => 10000);
  expect(j.handoffBlocked()).toBe(true); expect(j.pendingHandoffs(Infinity, 10)).toEqual([]);
});
test('Retry-After and backpressure hysteresis survive journal restart', async () => {
  vi.stubEnv('TEST_HANDOFF_TOKEN', 'synthetic-token-never-use-outside-this-test');
  const { j, path } = await journal(); enqueue(j);
  await drainHandoffs(source, j, async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }), () => 1000);
  expect(j.pendingHandoffs(120999, 10)).toEqual([]);
  for (let n = 1; n < 1000; n++) enqueue(j, { ...ref, recordId: String(n).padStart(64, '0') });
  expect(j.backpressure()).toBe(true);
  j.close(); journals.splice(journals.indexOf(j), 1);
  const restored = new Journal(path, 'test'); journals.push(restored);
  for (let n = 1; n <= 500; n++) restored.handoffAccepted(String(n).padStart(64, '0'));
  expect(restored.backpressure()).toBe(true);
  restored.handoffAccepted(ref.recordId); expect(restored.backpressure()).toBe(false);
});
test('native worker commits only after sealed receipt plus durable outbox and drains on empty polls', async () => {
  vi.stubEnv('TEST_HANDOFF_TOKEN', 'synthetic-token-never-use-outside-this-test');
  const dir = await directory(); const config = { sources: [source], stateFile: join(dir, 'worker.json') };
  let queue = [record], down = true, commitCount = 0, sealCount = 0;
  const create = () => createHandler({
    read: async (_source, j) => ({ records: queue, commit: async () => {
      expect(j.handoffBacklog()).toBe(1); commitCount++; queue = [];
    }, close: async () => {} }),
    sinkFactory: () => ({ ensure: async () => { sealCount++; return receipt; } }),
    handoffFetch: async () => down ? new Response(null, { status: 503 }) : Response.json({ accepted: true, recordId: ref.recordId, status: 'awaiting-workflow' }),
  }).createSourceWorkerDeps({ config });
  const run = async () => runSourceWorkerOnce(config.sources, config.stateFile, { ...await create(), now: () => new Date().toISOString(), getJobStatus: async () => { throw new Error('no publication'); } });
  await run(); expect(commitCount).toBe(1); expect(sealCount).toBe(1);
  const path = join(dir, `kafka-${hash(source.id).slice(0, 16)}.sqlite`);
  const j = new Journal(path, hash(source));
  expect(j.handoffBacklog()).toBe(1);
  j.db.prepare('UPDATE handoffs SET retryAt=0').run(); j.close();
  down = false; await run();
  const restored = new Journal(path, hash(source)); journals.push(restored);
  expect(restored.handoffBacklog()).toBe(0); expect(sealCount).toBe(1); expect(commitCount).toBe(1);
});
test('TLS files are referenced through environment, client key is private and peer verification stays on', async () => {
  const dir = await directory(); const ca = join(dir, 'ca.pem'), cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  for (const path of [ca, cert, key]) await writeFile(path, 'synthetic-pem', { mode: 0o600 });
  vi.stubEnv('TEST_CA_FILE', ca); vi.stubEnv('TEST_CERT_FILE', cert); vi.stubEnv('TEST_KEY_FILE', key);
  const configured = { caFileEnv: 'TEST_CA_FILE', certFileEnv: 'TEST_CERT_FILE', keyFileEnv: 'TEST_KEY_FILE' };
  expect(await kafkaTls(configured)).toEqual({ rejectUnauthorized: true, ca: 'synthetic-pem', cert: 'synthetic-pem', key: 'synthetic-pem' });
  await chmod(key, 0o644); await expect(kafkaTls(configured)).rejects.toThrow('KAFKA_TLS_FILE_INVALID');
  await expect(kafkaTls({ ...configured, ssl: false })).rejects.toThrow('KAFKA_TLS_REFS_INVALID');
  await expect(kafkaTls({ certFileEnv: 'TEST_CERT_FILE' })).rejects.toThrow('KAFKA_TLS_REFS_INVALID');
  const enrolled = enrollKafkaSource(registry, { id: source.id, groupId: source.groupId, fromBeginning: false,
    agentAddress: source.agentAddress, contextGraphId: source.contextGraphId, ...configured });
  expect(enrolled.keyFileEnv).toBe('TEST_KEY_FILE'); expect(JSON.stringify(enrolled)).not.toContain(dir);
});
