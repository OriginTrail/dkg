import { validateRegistryEntry, registryIriSchema } from '@origintrail-official/kafka-plugin/registry';

const LOCAL_FIELDS = ['id', 'groupId', 'clusterId', 'agentAddress', 'contextGraphId', 'usernameEnv', 'passwordEnv',
  'fromBeginning', 'maxMessages', 'maxBatchBytes', 'readTimeoutMs', 'clientId', 'maxRetries', 'mapping'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function transport(descriptor, allowPlaintext) {
  let endpoint;
  try { endpoint = new URL(descriptor.kafkaBootstrapUrl); }
  catch { throw new Error('KAFKA_REGISTRY_ENDPOINT_INVALID'); }
  if (!['kafka:', 'kafkas:'].includes(endpoint.protocol) || !endpoint.hostname || !endpoint.port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname && endpoint.pathname !== '/'))
    throw new Error('KAFKA_REGISTRY_ENDPOINT_INVALID');
  const method = (descriptor.kafkaAuthMethod ?? 'SSL').toUpperCase();
  if (!['SSL', 'SASL_SSL', 'PLAINTEXT'].includes(method)) throw new Error('KAFKA_REGISTRY_AUTH_UNSUPPORTED');
  const ssl = method !== 'PLAINTEXT';
  if ((!ssl && !allowPlaintext) || (!ssl && endpoint.protocol === 'kafkas:')) throw new Error('KAFKA_REGISTRY_TLS_REQUIRED');
  const saslMechanism = descriptor.kafkaSaslMechanism?.toLowerCase();
  if (method === 'SASL_SSL' && !['plain', 'scram-sha-256', 'scram-sha-512'].includes(saslMechanism))
    throw new Error('KAFKA_REGISTRY_SASL_UNSUPPORTED');
  if (method !== 'SASL_SSL' && saslMechanism) throw new Error('KAFKA_REGISTRY_AUTH_MISMATCH');
  return { brokers: [endpoint.host], topic: descriptor.kafkaTopicName, ssl,
    ...(saslMechanism ? { saslMechanism } : {}) };
}

/** Enrollment is explicit and separate from polling. No Kafka connection occurs here. */
export function enrollKafkaSource(value, options) {
  const entry = validateRegistryEntry(value);
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !LOCAL_FIELDS.includes(key) && key !== 'allowPlaintext'))
    throw new Error('KAFKA_REGISTRY_OPTIONS_INVALID');
  for (const key of ['id', 'groupId', 'contextGraphId']) {
    if (typeof options[key] !== 'string' || !options[key].trim()) throw new Error('KAFKA_REGISTRY_LOCAL_CONFIG_REQUIRED');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.agentAddress) || typeof options.fromBeginning !== 'boolean')
    throw new Error('KAFKA_REGISTRY_LOCAL_CONFIG_REQUIRED');
  const clusterId = entry.descriptor.clusterId ?? options.clusterId;
  if (typeof clusterId !== 'string' || !clusterId.trim() || (entry.descriptor.clusterId && options.clusterId && clusterId !== options.clusterId))
    throw new Error('KAFKA_REGISTRY_CLUSTER_REQUIRED');
  const connection = transport(entry.descriptor, options.allowPlaintext === true);
  for (const key of ['usernameEnv', 'passwordEnv']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !ENV_NAME.test(options[key])))
      throw new Error('KAFKA_REGISTRY_CREDENTIAL_REF_INVALID');
    if (connection.saslMechanism && !options[key]) throw new Error('KAFKA_REGISTRY_CREDENTIAL_REFS_REQUIRED');
  }
  return { ...Object.fromEntries(LOCAL_FIELDS.filter(key => options[key] !== undefined).map(key => [key, options[key]])),
    kind: 'kafka', clusterId, ...connection, registryRef: entry };
}

/** Validate the local pin before touching Kafka, offsets, journals, or DKG. */
export function validateRegisteredSource(source) {
  if (source.registryRef === undefined) return;
  const { registryRef, kind: _kind, brokers, topic, ssl, saslMechanism, ...options } = source;
  const expected = enrollKafkaSource(registryRef, { ...options, allowPlaintext: ssl === false });
  if (JSON.stringify(brokers) !== JSON.stringify(expected.brokers) || topic !== expected.topic
      || ssl !== expected.ssl || saslMechanism !== expected.saslMechanism)
    throw new Error('KAFKA_REGISTRY_SOURCE_MISMATCH');
}

/** Read only the operator-selected registry. Refuse redirects carrying its bearer token. */
export async function resolveKafkaRegistryEntry(options, fetchImpl = fetch) {
  const { registryUrl, ual, contextGraphId, registryToken, expectedDescriptorHash, expectedPublisherIri } = options;
  registryIriSchema.parse(ual);
  let base;
  try { base = new URL(registryUrl); } catch { throw new Error('KAFKA_REGISTRY_URL_INVALID'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error('KAFKA_REGISTRY_URL_INVALID');
  const url = new URL(base.href.replace(/\/$/, '') + '/' + encodeURIComponent(ual));
  url.searchParams.set('includeRegistry', 'true');
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...(registryToken ? { Authorization: `Bearer ${registryToken}` } : {}) } });
  } catch { throw new Error('KAFKA_REGISTRY_READ_FAILED'); }
  if (!response.ok) throw new Error(`KAFKA_REGISTRY_HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('KAFKA_REGISTRY_RESPONSE_INVALID');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('KAFKA_REGISTRY_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    throw new Error(error.message === 'KAFKA_REGISTRY_RESPONSE_TOO_LARGE'
      ? error.message : 'KAFKA_REGISTRY_READ_FAILED');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let entry;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    entry = validateRegistryEntry(payload.registry);
    if (payload['@id'] !== ual) throw new Error('UAL mismatch');
  } catch { throw new Error('KAFKA_REGISTRY_RESPONSE_INVALID'); }
  if (entry.ual !== ual || entry.contextGraphId !== contextGraphId
      || (expectedDescriptorHash !== undefined && entry.descriptorHash !== expectedDescriptorHash)
      || (expectedPublisherIri !== undefined && entry.publisherIri !== expectedPublisherIri))
    throw new Error('KAFKA_REGISTRY_PIN_MISMATCH');
  return entry;
}
