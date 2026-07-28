import { describe, it, expect } from 'vitest';
import {
  createValidator,
  assertWithinTraversalLimits,
  MAX_EPCIS_DEPTH,
  MAX_EPCIS_NODES,
} from '../src/validation.js';
import {
  VALID_OBJECT_EVENT_DOC,
  VALID_TRANSFORMATION_EVENT_DOC,
  VALID_AGGREGATION_EVENT_DOC,
  INVALID_DOC,
  EMPTY_EVENT_LIST_DOC,
} from './fixtures/bicycle-story.js';

describe('EPCIS validation', () => {
  const validator = createValidator();

  it('accepts a valid ObjectEvent document', () => {
    const result = validator.validate(VALID_OBJECT_EVENT_DOC);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(1);
    expect(result.errors).toBeUndefined();
  });

  it('rejects an invalid document with error details', () => {
    const result = validator.validate(INVALID_DOC);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('rejects a document with empty eventList', () => {
    const result = validator.validate(EMPTY_EVENT_LIST_DOC);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('eventList must contain at least one event');
  });

  it('accepts a valid TransformationEvent document', () => {
    const result = validator.validate(VALID_TRANSFORMATION_EVENT_DOC);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(1);
  });

  it('accepts a valid AggregationEvent document', () => {
    const result = validator.validate(VALID_AGGREGATION_EVENT_DOC);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(1);
  });
});

describe('EPCIS resource-exhaustion guard (CodeQL js/resource-exhaustion-from-deep-object-traversal)', () => {
  // The validator runs on raw JSON received over HTTP. Without an
  // explicit pre-Ajv depth/size cap, a hostile payload that bypasses
  // schema rejection by mimicking the EPCIS envelope can pin one
  // daemon worker on schema validation. These tests pin the guard
  // contract so a future refactor cannot quietly remove it.
  const validator = createValidator();

  it('rejects documents that exceed MAX_EPCIS_DEPTH (linear time)', () => {
    // Build `{a:{a:{a:...}}}` deeper than the cap.
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < MAX_EPCIS_DEPTH + 10; i++) {
      nested = { a: nested };
    }
    const t0 = performance.now();
    const result = validator.validate(nested);
    const elapsed = performance.now() - t0;
    expect(result.valid).toBe(false);
    expect(result.errors?.[0] ?? '').toMatch(/exceeds maximum nesting depth/);
    // Hang guard: even hostile inputs must reject in O(n) time.
    expect(elapsed).toBeLessThan(500);
  });

  it('rejects documents that exceed MAX_EPCIS_NODES (linear time)', () => {
    // Build a flat object with > maxNodes leaf scalars.
    const flat: Record<string, number> = {};
    for (let i = 0; i < MAX_EPCIS_NODES + 100; i++) {
      flat[`k${i}`] = i;
    }
    const t0 = performance.now();
    const result = validator.validate(flat);
    const elapsed = performance.now() - t0;
    expect(result.valid).toBe(false);
    expect(result.errors?.[0] ?? '').toMatch(/exceeds maximum node count/);
    expect(elapsed).toBeLessThan(1000);
  });

  it('fails fast instead of accumulating errors across a wide invalid event list', () => {
    const document = {
      ...VALID_OBJECT_EVENT_DOC,
      epcisBody: {
        eventList: Array.from({ length: 10_000 }, () => ({ type: 'ObjectEvent' })),
      },
    };

    const result = validator.validate(document);

    expect(result.valid).toBe(false);
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    expect(result.errors?.length ?? 0).toBeLessThan(20);
  });

  it('accepts documents at the boundary of the limits (depth = MAX, nodes < MAX)', () => {
    // depth exactly MAX_EPCIS_DEPTH must pass the guard (then fail
    // schema, which is fine — the guard's job is to ensure Ajv runs).
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < MAX_EPCIS_DEPTH; i++) {
      nested = { a: nested };
    }
    expect(() => assertWithinTraversalLimits(nested)).not.toThrow();
  });

  it('does not recurse — guard itself is stack-safe', () => {
    // A truly pathological input would blow the JS stack if the
    // guard recursed. The iterative implementation must handle
    // depths >> JS stack limit and reject cleanly.
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) {
      nested = { a: nested };
    }
    expect(() => assertWithinTraversalLimits(nested)).toThrow(/exceeds maximum nesting depth/);
  });

  it('exported limits match the documented contract', () => {
    expect(MAX_EPCIS_DEPTH).toBe(64);
    expect(MAX_EPCIS_NODES).toBe(100_000);
  });
});
