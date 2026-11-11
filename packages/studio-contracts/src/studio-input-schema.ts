import { STUDIO_MAX_INPUTS } from './studio-interface-limits.js';
import { z } from 'zod';
import { studioParameterSchema, STUDIO_INPUT_MAX_ENTRIES } from './studio-parameter.js';
export const isStudioInputName = (value: string) =>
  /^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(value) &&
  !['constructor', 'prototype', '__proto__'].includes(value) &&
  !value.startsWith('__nos');

/** One structure; only draft completeness and unknown-field policy differ by ingestion boundary. */
function componentInputSchema(strict: boolean, draft: boolean) {
  const target = z.object({
    nodeId: z.string(),
    parameter: z.string(),
    kind: z.literal('input').optional(),
  });
  const input = z.object({
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/)
      .refine(isStudioInputName),
    label: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => !!value.trim()),
    description: z.string().max(300).optional(),
    required: z.boolean(),
    targets: z
      .array(strict ? target.strict() : target)
      .min(draft ? 0 : 1)
      .max(STUDIO_INPUT_MAX_ENTRIES),
    spec: strict ? studioParameterSchema.strict() : studioParameterSchema,
  });
  return strict ? input.strict() : input;
}
export const studioComponentInputSchema = componentInputSchema(false, false);
export type StudioComponentInput = z.infer<typeof studioComponentInputSchema>;
export const studioInputsSchema = z.array(studioComponentInputSchema).max(STUDIO_MAX_INPUTS);
export const studioDraftInputsSchema = z
  .array(componentInputSchema(false, true))
  .max(STUDIO_MAX_INPUTS);
export const studioWorkflowInputsSchema = z
  .array(componentInputSchema(true, false))
  .max(STUDIO_MAX_INPUTS);
