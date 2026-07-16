import type { BenchmarkConfig, BenchmarkPayload } from './types.js';

export type PayloadFlow = 'sync' | 'async';

export function createPayload(
  config: Pick<BenchmarkConfig, 'fixture' | 'payloadSizeBytes'>,
  runId: string,
  iteration: number,
  flow: PayloadFlow,
  warmup: boolean,
): BenchmarkPayload {
  const sample = warmup ? `warmup-${iteration}` : `measured-${iteration}`;
  const rootEntity = `urn:dkg:benchmark:publish-async-get:${runId}:${sample}:${flow}`;
  const marker = `dkg-benchmark-${runId}-${sample}-${flow}`;
  const graph = `urn:dkg:benchmark:publish-async-get:${runId}:${sample}`;
  const baseText = config.fixture === 'minimal'
    ? marker
    : `${marker}:${'x'.repeat(Math.max(0, config.payloadSizeBytes - marker.length - 1))}`;

  return {
    rootEntity,
    marker,
    quads: [
      {
        subject: rootEntity,
        predicate: 'http://schema.org/identifier',
        object: literal(marker),
        graph,
      },
      {
        subject: rootEntity,
        predicate: 'http://schema.org/name',
        object: literal(`DKG publish async get benchmark ${sample}`),
        graph,
      },
      {
        subject: rootEntity,
        predicate: 'http://schema.org/text',
        object: literal(baseText),
        graph,
      },
    ],
  };
}

export function getSparql(rootEntity: string): string {
  return `SELECT ?value WHERE { <${rootEntity}> <http://schema.org/identifier> ?value . } LIMIT 10`;
}

export function validateQueryContainsMarker(result: unknown, marker: string): void {
  const bindings = hasBindings(result) ? result.bindings : [];
  const values = bindings.flatMap((binding) => Object.values(binding).map(bindingValue));
  if (!values.some((value) => value === marker || value.includes(marker))) {
    throw new Error(`Get query did not return benchmark marker ${marker}`);
  }
}

function hasBindings(value: unknown): value is { bindings: Array<Record<string, unknown>> } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { bindings?: unknown }).bindings));
}

function bindingValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/^"|"$/g, '');
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value;
  }
  return String(value ?? '');
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
