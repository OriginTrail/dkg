import { z } from 'zod';
export const STUDIO_INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'json'] as const;
// Metadata remains bounded independently of the complete saved-source budget.
export const STUDIO_INPUT_MAX_ENTRIES = 8192;
const parameterShape = {
  type: z.enum(STUDIO_INPUT_TYPES),
  label: z.string().max(100),
  default: z.unknown(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  options: z.array(z.string().max(512)).max(STUDIO_INPUT_MAX_ENTRIES).optional(),
  pattern: z.string().optional(),
  shape: z.literal('any').optional(),
};
const parameterStructure = z.object(parameterShape);
export type StudioParameter = z.infer<typeof parameterStructure>;
export const studioParameterSchema = parameterStructure.refine(
  (value) => Object.hasOwn(value, 'default') && consistentParameterConstraints(value),
  'Invalid public input constraints',
);

/** Existing native descriptor acceptance; extra constraints remain runtime-owned. */
const nativeParameterSchema = parameterStructure
  .pick({ type: true, label: true, default: true })
  .extend({ options: z.array(parameterShape.options.unwrap().element).optional() })
  .refine((value) => Object.hasOwn(value, 'default'));
export function isStudioParameter(value: unknown): value is StudioParameter {
  return nativeParameterSchema.safeParse(value).success;
}
/** Public recipe/invocation inputs additionally require internally consistent constraints. */
export function isStudioInputParameter(value: unknown): value is StudioParameter {
  return studioParameterSchema.safeParse(value).success;
}
function consistentParameterConstraints(value: StudioParameter) {
  return !(
    ((value.min !== undefined || value.max !== undefined) &&
      !['integer', 'number'].includes(value.type)) ||
    (value.maxLength !== undefined && !['string', 'json'].includes(value.type)) ||
    ((value.pattern !== undefined || value.options !== undefined) && value.type !== 'string') ||
    (value.shape !== undefined && value.type !== 'json') ||
    (value.min !== undefined && !Number.isFinite(value.min)) ||
    (value.max !== undefined && !Number.isFinite(value.max)) ||
    (value.min !== undefined && value.max !== undefined && value.min > value.max) ||
    (value.maxLength !== undefined &&
      (!Number.isSafeInteger(value.maxLength) || value.maxLength < 0)) ||
    (value.pattern !== undefined && !['field', 'http'].includes(value.pattern)) ||
    (value.shape !== undefined && value.shape !== 'any') ||
    (value.options !== undefined && value.options.length > STUDIO_INPUT_MAX_ENTRIES)
  );
}
