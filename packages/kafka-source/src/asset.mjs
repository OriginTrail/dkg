import { createHash } from 'node:crypto';
import { canonicalizeRdfObjectTerm, formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

const literalTerm = value => formatCanonicalRdfLiteralTerm({ kind: 'plain', value: String(value) });

export const NS = 'https://ontology.dkg.io/streams#';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const position = (source, record) => [source.clusterId, record.topic, record.partition, record.offset];
export const assetIdentity = (source, record) => {
  const identity = [position(source, record), source.id, source.mapping ?? []];
  if (source.registryRef) identity.push(['registry-v1', source.registryRef.contextGraphId,
    source.registryRef.ual, source.registryRef.descriptorHash, source.registryRef.publisherIri ?? null]);
  return hash(identity);
};

export function buildAsset(source, record) {
  const identity = assetIdentity(source, record);
  const subject = `urn:dkg:kafka:record:${identity}`;
  const quads = [];
  const literal = (key, value) => quads.push({ subject, predicate: NS + key, object: literalTerm(value), graph: '' });
  quads.push({ subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: NS + 'KafkaSourceRecord', graph: '' });
  literal('sourceId', source.id);
  literal('sourceSystem', source.clusterId);
  literal('kafkaTopic', record.topic);
  literal('kafkaPartition', record.partition);
  literal('kafkaOffset', record.offset);
  literal('sourceFetchedAt', record.fetchedAt);
  literal('mappingVersion', 'kafka-envelope-v1');
  literal('sourceRecordJson', JSON.stringify(record));
  if (source.registryRef) {
    const ref = source.registryRef;
    quads.push({ subject, predicate: NS + 'registryUal', object: ref.ual, graph: '' });
    literal('registryContextGraphId', ref.contextGraphId);
    literal('registryDescriptorHash', ref.descriptorHash);
    if (ref.publisherIri) quads.push({ subject, predicate: NS + 'registryPublisher', object: ref.publisherIri, graph: '' });
  }
  // Optional, operator-defined projection. Kafka itself supplies no domain
  // ontology; bytes and Kafka provenance are always retained verbatim.
  if (source.mapping?.length && record.valueBase64 !== null) {
    let value;
    try { value = JSON.parse(Buffer.from(record.valueBase64, 'base64').toString('utf8')); }
    catch { throw new Error('KAFKA_MAPPING_JSON_REQUIRED'); }
    for (const { field, predicate } of source.mapping) {
      if (value?.[field] !== undefined && value[field] !== null) {
        if (!['string', 'number', 'boolean'].includes(typeof value[field])) throw new Error('KAFKA_MAPPING_SCALAR_REQUIRED');
        quads.push({ subject, predicate, object: literalTerm(value[field]), graph: '' });
      }
    }
  }
  return { name: `kafka-record-${identity}`, subject, quads };
}

// Compare RDF values with the same canonical term boundary as native storage.
export function content(quads) {
  return [...new Set(quads.map(q => JSON.stringify([q.subject, q.predicate,
    canonicalizeRdfObjectTerm(q.object)])))].sort();
}
