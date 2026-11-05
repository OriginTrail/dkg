import { test, expect, vi, afterEach } from 'vitest';
import { descriptorHash, validateRegistryEntry } from '@origintrail-official/kafka-plugin/registry';
import { enrollKafkaSource, validateRegisteredSource, resolveKafkaRegistryEntry } from '../src/registry.mjs';
import { createHandler } from '../src/handler.mjs';
import { assetIdentity, buildAsset } from '../src/asset.mjs';

const owner = '0x' + 'a'.repeat(40);
const ual = `did:dkg:31337/${owner}/1`;
function entry(overrides = {}, metadata = {}) {
  const descriptor = { name: 'Application events', kafkaBootstrapUrl: 'kafka://broker.example:9094',
    kafkaTopicName: 'application.events', kafkaAuthMethod: 'SSL', dataFormat: 'JSON', clusterId: 'example-cluster',
    providerIri: 'urn:provider:alpha', about: ['urn:application:one'], registeredByAgentAddress: owner, ...overrides };
  return validateRegistryEntry({ version: 1, ual, contextGraphId: 'catalog', publisherIri: `did:dkg:agent:${owner}`,
    descriptor, descriptorHash: descriptorHash(descriptor), ...metadata });
}
const options = { id: 'selected-events', groupId: 'local-consumer', agentAddress: owner,
  contextGraphId: owner + '/private-events', fromBeginning: false };
const readOptions = { registryUrl: 'https://registry.example/api/kafka/streams', ual, contextGraphId: 'catalog', registryToken: 'private-token' };
const payload = value => Response.json({ '@id': value.ual, registry: value });
afterEach(() => { vi.restoreAllMocks(); });

test('explicit enrollment builds a pinned config with only local consumer authority', () => {
  const snapshot = entry();
  const source = enrollKafkaSource(snapshot, { ...options, maxMessages: 2, readTimeoutMs: 1000 });
  expect(source).toMatchObject({ ...options, kind: 'kafka', brokers: ['broker.example:9094'],
    topic: 'application.events', ssl: true, registryRef: snapshot });
  expect(source).not.toHaveProperty('saslMechanism');
  validateRegisteredSource(source);
  validateRegisteredSource({ ...source, registryRef: undefined });
});

test('SASL enrollment requires environment references without retrieving their values', () => {
  const snapshot = entry({ kafkaBootstrapUrl: 'kafkas://broker.example:9094', kafkaAuthMethod: 'SASL_SSL', kafkaSaslMechanism: 'SCRAM-SHA-512' });
  const source = enrollKafkaSource(snapshot, { ...options, usernameEnv: 'KAFKA_USERNAME', passwordEnv: 'KAFKA_PASSWORD' });
  expect(source.saslMechanism).toBe('scram-sha-512');
  validateRegisteredSource(source);
  expect(() => enrollKafkaSource(snapshot, options)).toThrow('KAFKA_REGISTRY_CREDENTIAL_REFS_REQUIRED');
  expect(() => enrollKafkaSource(snapshot, { ...options, usernameEnv: 'secret value', passwordEnv: 'PASSWORD' })).toThrow('KAFKA_REGISTRY_CREDENTIAL_REF_INVALID');
  expect(() => enrollKafkaSource(snapshot, { ...options, usernameEnv: 42 })).toThrow('KAFKA_REGISTRY_CREDENTIAL_REF_INVALID');
});

test('legacy registrations need an explicit stable cluster namespace', () => {
  const snapshot = entry({ clusterId: undefined, about: undefined, registeredByAgentAddress: undefined });
  expect(() => enrollKafkaSource(snapshot, options)).toThrow('KAFKA_REGISTRY_CLUSTER_REQUIRED');
  validateRegisteredSource(enrollKafkaSource(snapshot, { ...options, clusterId: 'operator-assigned' }));
  expect(enrollKafkaSource(entry({ kafkaAuthMethod: undefined }), options).ssl).toBe(true);
  expect(() => enrollKafkaSource(entry(), { ...options, clusterId: 'different' })).toThrow('KAFKA_REGISTRY_CLUSTER_REQUIRED');
});

test('plaintext is explicit and SASL or kafkas cannot be downgraded', () => {
  const plain = entry({ kafkaBootstrapUrl: 'kafka://localhost:19092', kafkaAuthMethod: 'PLAINTEXT' });
  expect(() => enrollKafkaSource(plain, options)).toThrow('KAFKA_REGISTRY_TLS_REQUIRED');
  const source = enrollKafkaSource(plain, { ...options, allowPlaintext: true });
  expect(source.ssl).toBe(false); validateRegisteredSource(source);
  expect(() => enrollKafkaSource(entry({ kafkaBootstrapUrl: 'kafkas://broker:9094', kafkaAuthMethod: 'PLAINTEXT' }), { ...options, allowPlaintext: true })).toThrow('KAFKA_REGISTRY_TLS_REQUIRED');
  expect(() => enrollKafkaSource(entry({ kafkaAuthMethod: 'SASL_PLAINTEXT' }), options)).toThrow('KAFKA_REGISTRY_AUTH_UNSUPPORTED');
  expect(() => enrollKafkaSource(entry({ kafkaAuthMethod: 'SASL_SSL', kafkaSaslMechanism: 'OAUTHBEARER' }), options)).toThrow('KAFKA_REGISTRY_SASL_UNSUPPORTED');
  expect(() => enrollKafkaSource(entry({ kafkaSaslMechanism: 'PLAIN' }), options)).toThrow('KAFKA_REGISTRY_AUTH_MISMATCH');
});

test.each(['not-a-url', 'https://broker:9094', 'kafka://user:secret@broker:9094', 'kafka://broker:9094/path',
  'kafka://broker', 'kafka://broker:9094?token=secret', 'kafka://broker:9094#x'])('rejects non-bootstrap endpoint %s', kafkaBootstrapUrl => {
  expect(() => enrollKafkaSource(entry({ kafkaBootstrapUrl }), options)).toThrow();
});

test.each([null, [], {}, { ...options, id: '' }, { ...options, agentAddress: 'bad' }, { ...options, fromBeginning: undefined },
  { ...options, brokers: ['attacker:9092'] }, { ...options, daemonToken: 'secret' }])('rejects incomplete or injected consumer options %#', value => {
  expect(() => enrollKafkaSource(entry(), value)).toThrow();
});

test('tampering is rejected before Kafka or journal side effects', async () => {
  const source = enrollKafkaSource(entry(), options);
  for (const change of [{ topic: 'different' }, { brokers: ['different:9094'] }, { ssl: false }, { saslMechanism: 'plain' }]) {
    expect(() => validateRegisteredSource({ ...source, ...change })).toThrow('KAFKA_REGISTRY_SOURCE_MISMATCH');
  }
  const read = vi.fn();
  const bad = { ...source, registryRef: { ...source.registryRef,
    descriptor: { ...source.registryRef.descriptor, kafkaTopicName: 'changed' } } };
  await expect(createHandler({ read }).createSourceWorkerDeps({ config: { sources: [bad] } })).rejects.toThrow('KAFKA_REGISTRY_HASH_MISMATCH');
  expect(read).not.toHaveBeenCalled();
});

test('the registration pin participates in identity and event provenance', () => {
  const source = enrollKafkaSource(entry(), options);
  const record = { topic: source.topic, partition: 0, offset: '17', fetchedAt: '2026-10-26T10:00:00Z', valueBase64: null };
  const first = buildAsset(source, record);
  expect(first.quads).toContainEqual(expect.objectContaining({ predicate: 'https://ontology.dkg.io/streams#registryUal', object: ual }));
  expect(first.quads).toContainEqual(expect.objectContaining({ predicate: 'https://ontology.dkg.io/streams#registryPublisher', object: source.registryRef.publisherIri }));
  expect(assetIdentity(source, record)).toBe(assetIdentity(structuredClone(source), { ...record, fetchedAt: '2030-01-01T00:00:00Z' }));
  expect(assetIdentity(source, record)).not.toBe(assetIdentity({ ...source, registryRef: undefined }, record));
  const next = enrollKafkaSource(entry({}, { ual: 'urn:registry:new' }), options);
  expect(assetIdentity(next, record)).not.toBe(assetIdentity(source, record));
  const unattributed = enrollKafkaSource(entry({}, { publisherIri: undefined }), options);
  expect(buildAsset(unattributed, record).quads.some(q => q.predicate.endsWith('registryPublisher'))).toBe(false);
});

test('resolver uses one authenticated read of the selected registry and validates the pin', async () => {
  const snapshot = entry();
  const fetch = vi.fn(async (url, init) => {
    expect(url.href).toBe(readOptions.registryUrl + '/' + encodeURIComponent(ual) + '?includeRegistry=true');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer private-token');
    return payload(snapshot);
  });
  expect(await resolveKafkaRegistryEntry({ ...readOptions, expectedDescriptorHash: snapshot.descriptorHash,
    expectedPublisherIri: snapshot.publisherIri }, fetch)).toEqual(snapshot);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await resolveKafkaRegistryEntry({ ...readOptions, registryToken: undefined }, async (_url, init) => {
    expect(init.headers).not.toHaveProperty('Authorization'); return payload(snapshot);
  })).toEqual(snapshot);
});

test.each([{ contextGraphId: 'wrong' }, { ual: 'urn:other' }, { expectedDescriptorHash: 'sha256:wrong' },
  { expectedPublisherIri: 'urn:other' }])('rejects another selected scope or pin %#', async changed => {
  const fetch = async () => payload(entry());
  await expect(resolveKafkaRegistryEntry({ ...readOptions, ...changed }, fetch)).rejects.toThrow(/KAFKA_REGISTRY_(PIN_MISMATCH|RESPONSE_INVALID)/);
});

test('resolver sanitizes HTTP, transport, body and oversized response failures', async () => {
  await expect(resolveKafkaRegistryEntry(readOptions, async () => { throw new Error('private-token'); })).rejects.toThrow('KAFKA_REGISTRY_READ_FAILED');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => new Response('private-token', { status: 403 }))).rejects.toThrow('KAFKA_REGISTRY_HTTP_403');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => new Response(null))).rejects.toThrow('KAFKA_REGISTRY_RESPONSE_INVALID');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => new Response('bad json'))).rejects.toThrow('KAFKA_REGISTRY_RESPONSE_INVALID');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => payload({ ...entry(), descriptorHash: 'sha256:' + '0'.repeat(64) }))).rejects.toThrow('KAFKA_REGISTRY_RESPONSE_INVALID');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => new Response('x'.repeat(1024 * 1024 + 1)))).rejects.toThrow('KAFKA_REGISTRY_RESPONSE_TOO_LARGE');
  await expect(resolveKafkaRegistryEntry(readOptions, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret')); } })))).rejects.toThrow('KAFKA_REGISTRY_READ_FAILED');
});

test.each(['bad url', 'file:///tmp/catalog', 'https://user:secret@registry.example', 'https://registry.example?token=secret', 'https://registry.example#x'])('rejects unsafe operator registry URL %s', async registryUrl => {
  const fetch = vi.fn();
  await expect(resolveKafkaRegistryEntry({ ...readOptions, registryUrl }, fetch)).rejects.toThrow('KAFKA_REGISTRY_URL_INVALID');
  expect(fetch).not.toHaveBeenCalled();
});
