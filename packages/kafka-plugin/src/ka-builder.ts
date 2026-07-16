import type { CoreFields } from './schema.js';

export interface KafkaStreamKa {
  '@context': Record<string, string>;
  '@type': string | string[];
  'dkg-streams:protocol': 'kafka';
  'schema:name': string;
  'schema:description'?: string;
  'dkg-streams:kafkaBootstrapUrl'?: string;
  'dkg-streams:kafkaTopicName'?: string;
  'dkg-streams:kafkaAuthMethod'?: string;
  'dkg-streams:kafkaSaslMechanism'?: string;
  'dkg-streams:dataFormat'?: string;
  [key: string]: unknown;
}

const DKG_STREAMS_MAPPING: Array<[keyof CoreFields, string]> = [
  ['kafkaBootstrapUrl', 'dkg-streams:kafkaBootstrapUrl'],
  ['kafkaTopicName', 'dkg-streams:kafkaTopicName'],
  ['kafkaAuthMethod', 'dkg-streams:kafkaAuthMethod'],
  ['kafkaSaslMechanism', 'dkg-streams:kafkaSaslMechanism'],
  ['dataFormat', 'dkg-streams:dataFormat'],
];

export function mergeAugmentFragment(
  baseKa: KafkaStreamKa,
  augmentFragment: Record<string, unknown>,
  loggedCollisionKeys: Set<string>,
): KafkaStreamKa {
  // ADR 0004: `@type` and `@context` are extensible (multi-type / multi-prefix).
  // Every other key keeps the core-wins-with-log-once contract.
  const merged: KafkaStreamKa = { ...baseKa };
  for (const [key, value] of Object.entries(augmentFragment)) {
    if (key === '@type') {
      merged['@type'] = mergeTypes(baseKa['@type'], value);
      continue;
    }
    if (key === '@context') {
      merged['@context'] = mergeContexts(baseKa['@context'], value, loggedCollisionKeys);
      continue;
    }
    if (key.startsWith('@')) {
      logCollisionOnce(key, loggedCollisionKeys);
      continue;
    }
    if (key in baseKa) {
      logCollisionOnce(key, loggedCollisionKeys);
      continue;
    }
    if (!isScalarAugmentValue(value)) {
      logUnsupportedValueOnce(key, loggedCollisionKeys);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function mergeTypes(baseType: KafkaStreamKa['@type'], extType: unknown): string | string[] {
  const baseArr = Array.isArray(baseType) ? baseType : [baseType];
  const extArr =
    Array.isArray(extType) ? extType.filter((t): t is string => typeof t === 'string')
    : typeof extType === 'string' ? [extType]
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...baseArr, ...extArr]) {
    if (typeof t !== 'string' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length === 1 ? out[0] : out;
}

function mergeContexts(
  baseCtx: Record<string, string>,
  extCtx: unknown,
  loggedCollisionKeys: Set<string>,
): Record<string, string> {
  if (!extCtx || typeof extCtx !== 'object' || Array.isArray(extCtx)) return { ...baseCtx };
  const merged: Record<string, string> = { ...baseCtx };
  for (const [prefix, iri] of Object.entries(extCtx as Record<string, unknown>)) {
    if (typeof iri !== 'string') continue;
    if (prefix in baseCtx) {
      logCollisionOnce(`@context:${prefix}`, loggedCollisionKeys);
      continue;
    }
    merged[prefix] = iri;
  }
  return merged;
}

function logCollisionOnce(key: string, loggedCollisionKeys: Set<string>): void {
  if (loggedCollisionKeys.has(key)) return;
  loggedCollisionKeys.add(key);
  console.warn(
    `kafka-plugin: extension augment dropped colliding key "${key}" (core wins).`,
  );
}

function logUnsupportedValueOnce(key: string, loggedCollisionKeys: Set<string>): void {
  const logKey = `non-scalar:${key}`;
  if (loggedCollisionKeys.has(logKey)) return;
  loggedCollisionKeys.add(logKey);
  console.warn(
    `kafka-plugin: extension augment dropped non-scalar key "${key}" (only scalar values round-trip).`,
  );
}

function isScalarAugmentValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function buildKa(parsed: CoreFields): KafkaStreamKa {
  const ka: KafkaStreamKa = {
    '@context': {
      'dkg-streams': 'https://ontology.dkg.io/streams#',
      schema: 'https://schema.org/',
    },
    '@type': 'dkg-streams:KafkaStream',
    'dkg-streams:protocol': 'kafka',
    'schema:name': parsed.name,
  };
  if (parsed.description !== undefined) {
    ka['schema:description'] = parsed.description;
  }
  for (const [field, iri] of DKG_STREAMS_MAPPING) {
    const value = parsed[field];
    if (value !== undefined) {
      ka[iri] = value;
    }
  }
  return ka;
}
