import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import epcisSchema from './schemas/epcis-json-schema.json' with { type: 'json' };
import type { EPCISDocument, EPCISEvent, ValidationResult } from './types.js';

export interface EpcisValidator {
  validate(document: unknown): ValidationResult;
  extractEvents(document: EPCISDocument): EPCISEvent[];
}

export function createValidator(): EpcisValidator {
  const ajv = new (Ajv as unknown as typeof Ajv.default)({ allErrors: true, strict: false, validateFormats: true });
  (addFormats as unknown as typeof addFormats.default)(ajv);
  const validateSchema = ajv.compile(epcisSchema);

  return {
    validate(document: unknown): ValidationResult {
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
