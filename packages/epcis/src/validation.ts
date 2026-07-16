import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import epcisSchema from './schemas/epcis-json-schema.json' with { type: 'json' };
import type { EPCISDocument, EPCISEvent, ValidationResult } from './types.js';

export interface EpcisValidator {
  validate(document: unknown): ValidationResult;
  extractEvents(document: EPCISDocument): EPCISEvent[];
}

// Defense-in-depth caps for the structural traversal that runs BEFORE
// Ajv. Ajv itself does NOT impose recursion or fan-out limits, so an
// adversarial caller can post a deeply-nested document (e.g.
// `{a:{a:{a:...}}}` 10⁵ levels deep) and pin one EPCIS daemon worker
// in `validateSchema`. The daemon `MAX_BODY_BYTES` cap (~10 MB by
// default) bounds the wire size, but 10 MB of JSON is still enough to
// produce extreme nesting. These constants stay well above any
// legitimate EPCIS document — real-world EPCIS docs are 4-8 levels
// deep and rarely exceed 10⁴ scalar nodes for the largest event
// batches — while killing the unbounded-recursion attack surface.
//
// Hard-coded rather than configurable: an operator who wants to lift
// the cap can fork. The vast majority of operators benefit from a
// sane default; making this tunable invites mis-configuration.
export const MAX_EPCIS_DEPTH = 64;
export const MAX_EPCIS_NODES = 100_000;

/**
 * Walk `document` iteratively and reject if it would blow either
 * `MAX_EPCIS_DEPTH` or `MAX_EPCIS_NODES`. Throws on violation; returns
 * silently otherwise. Iterative (not recursive) so it cannot itself
 * be a recursion-depth DoS vector.
 */
export function assertWithinTraversalLimits(
  document: unknown,
  maxDepth = MAX_EPCIS_DEPTH,
  maxNodes = MAX_EPCIS_NODES,
): void {
  let nodeCount = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: document, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodeCount > maxNodes) {
      throw new Error(`EPCIS document exceeds maximum node count (${maxNodes}); refusing to validate`);
    }
    if (depth > maxDepth) {
      throw new Error(`EPCIS document exceeds maximum nesting depth (${maxDepth}); refusing to validate`);
    }
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else {
      for (const key of Object.keys(value as object)) {
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
}

export function createValidator(): EpcisValidator {
  const ajv = new (Ajv as unknown as typeof Ajv.default)({ allErrors: true, strict: false, validateFormats: true });
  (addFormats as unknown as typeof addFormats.default)(ajv);
  const validateSchema = ajv.compile(epcisSchema);

  return {
    validate(document: unknown): ValidationResult {
      // Hard-fail BEFORE Ajv on anything that would let an attacker
      // spend unbounded CPU inside the schema validator. CodeQL alert
      // js/resource-exhaustion-from-deep-object-traversal.
      try {
        assertWithinTraversalLimits(document);
      } catch (err) {
        return {
          valid: false,
          errors: [(err as Error).message],
        };
      }

      const isValid = validateSchema(document);

      if (!isValid) {
        const errors = validateSchema.errors?.map(
          (err: { instancePath?: string; message?: string }) => `${err.instancePath || '/'}: ${err.message}`,
        ) ?? ['Unknown validation error'];
        return { valid: false, errors };
      }

      const doc = document as EPCISDocument;
      const eventList = doc.epcisBody?.eventList ?? [];

      if (eventList.length === 0) {
        return { valid: false, errors: ['eventList must contain at least one event'] };
      }

      return { valid: true, eventCount: eventList.length };
    },

    extractEvents(document: EPCISDocument): EPCISEvent[] {
      return document.eventList ?? document.epcisBody?.eventList ?? [];
    },
  };
}
