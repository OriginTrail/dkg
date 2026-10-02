import { createRequire } from 'node:module';
import { normalizeCaptureEventTypes } from './capture-event-types.js';
import { EPCIS_DECLARED_EVENT_TYPE } from './epcis-vocabulary.js';
import { assertWithinTraversalLimits } from './validation.js';

type DocumentLoader = (url: string) => Promise<unknown>;
const jsonld = createRequire(import.meta.url)('jsonld') as {
  expand(document: unknown, options: { documentLoader: DocumentLoader }): Promise<unknown[]>;
  documentLoaders: { node(): DocumentLoader };
};

/**
 * Publish the inspected expansion itself: later conversion cannot re-fetch a
 * changed remote context and introduce a caller-supplied reserved declaration.
 */
export async function prepareCaptureContentRdf(content: { public?: unknown; private?: unknown }): Promise<{ public?: unknown; private?: unknown }> {
  const subjects = new Map<string, string>();
  return {
    ...('public' in content ? { public: await prepareCaptureRdf(content.public, subjects) } : {}),
    ...('private' in content ? { private: await prepareCaptureRdf(content.private, subjects) } : {}),
  };
}

async function prepareCaptureRdf(document: unknown, subjects: Map<string, string>): Promise<unknown[]> {
  assertWithinTraversalLimits(document);
  const remote = jsonld.documentLoaders.node();
  const contexts = new Map<string, Promise<unknown>>();
  const documentLoader: DocumentLoader = async url => {
    let cached = contexts.get(url);
    if (!cached) { cached = remote(url); contexts.set(url, cached); }
    return structuredClone(await cached);
  };
  const original = await jsonld.expand(document, { documentLoader });
  visitNodes(original, node => {
    if (EPCIS_DECLARED_EVENT_TYPE in node) {
      throw new Error('The EPCIS event-type declaration is reserved for capture normalization');
    }
  });
  const normalized = normalizeCaptureEventTypes(document);
  const expectedDeclarations: string[] = [];
  visitNodes(normalized, node => {
    const value = node[EPCIS_DECLARED_EVENT_TYPE];
    if (value && typeof value === 'object' && '@id' in value && typeof value['@id'] === 'string') {
      expectedDeclarations.push(value['@id']);
    }
  });
  const expanded = await jsonld.expand(normalized, { documentLoader });
  const declarations: string[] = [];
  visitNodes(expanded, node => {
    const values = node[EPCIS_DECLARED_EVENT_TYPE];
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const iri = value && typeof value === 'object' ? value['@id'] : undefined;
      if (typeof iri !== 'string') throw new Error('Invalid reserved EPCIS event-type declaration');
      declarations.push(iri);
      const id = node['@id'];
      if (typeof id === 'string') {
        const previous = subjects.get(id);
        if (previous && previous !== iri) throw new Error('Conflicting reserved EPCIS event-type declarations for one event');
        subjects.set(id, iri);
      }
    }
  });
  if (JSON.stringify(declarations.sort()) !== JSON.stringify(expectedDeclarations.sort())) {
    throw new Error('JSON-LD context changed the reserved EPCIS event-type declaration');
  }
  return expanded;
}

function visitNodes(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { for (const item of current) stack.push(item); }
    else {
      const node = current as Record<string, unknown>;
      visit(node);
      for (const item of Object.values(node)) stack.push(item);
    }
  }
}
