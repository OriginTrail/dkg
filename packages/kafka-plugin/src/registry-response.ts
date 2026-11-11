import { createRegistryEntry } from './registry.js';

export function includeRegistry(params: URLSearchParams): boolean {
  const value = params.get('includeRegistry');
  if (params.getAll('includeRegistry').length > 1 || (value !== null && value !== 'true' && value !== 'false')) {
    throw new Error('includeRegistry must be true or false');
  }
  return value === 'true';
}

export function withRegistry(
  ka: Record<string, unknown>, ual: string, contextGraphId: string,
  bindings: ReadonlyArray<Record<string, unknown>>, enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return ka;
  const publishers = new Set(bindings.flatMap(row => {
    const term = row.publisher;
    const value = typeof term === 'string' ? term
      : term && typeof term === 'object' ? (term as { value?: unknown }).value : undefined;
    return typeof value === 'string' ? [value.replace(/^<|>$/g, '')] : [];
  }));
  if (publishers.size > 1) throw new Error('Ambiguous registry publisher');
  return { ...ka, registry: createRegistryEntry(ka, ual, contextGraphId, [...publishers][0]) };
}
