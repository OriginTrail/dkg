import upstreamSchema from './schemas/epcis-json-schema.json' with { type: 'json' };
import { EPCIS_STANDARD_EVENT_TYPES, EPCIS_TYPE_PREFIX } from './epcis-vocabulary.js';

/**
 * Extend the bundled GS1 discriminator enums once at validator construction.
 * The artifact stays unchanged; both positive dispatch and Extended-Event
 * exclusions use this single alias policy. No capture document is rewritten.
 */
export function createEpcisValidationSchema(): typeof upstreamSchema {
  const schema = structuredClone(upstreamSchema);
  const aliases = new Map<string, string>(EPCIS_STANDARD_EVENT_TYPES
    .map((type) => [type, `${EPCIS_TYPE_PREFIX}${type}`]));
  const stack: unknown[] = [schema];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum)) {
      record.enum = record.enum.flatMap((value: unknown) => {
        const alias = typeof value === 'string' ? aliases.get(value) : undefined;
        return alias ? [value, alias] : [value];
      });
    }
    stack.push(...Object.values(record));
  }
  return schema;
}
