import { describe, it, expect } from 'vitest';
import { createValidator } from '../src/validation.js';
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
