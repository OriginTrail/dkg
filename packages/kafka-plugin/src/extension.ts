import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from 'zod';

export interface KafkaPluginExtension<TParsed> {
  schema: ZodObject<ZodRawShape>;
  augment: (parsed: TParsed) => Record<string, unknown>;
}

export class ExtensionSchemaCollisionError extends Error {
  readonly collidingKeys: string[];
  constructor(collidingKeys: string[]) {
    super(
      `kafka-plugin extension schema redeclares core key(s): ${collidingKeys.join(', ')}. ` +
        'Extensions must add only fields outside the core schema.',
    );
    this.name = 'ExtensionSchemaCollisionError';
    this.collidingKeys = collidingKeys;
  }
}

export class ExtensionSchemaUnsupportedFieldError extends Error {
  readonly unsupportedFields: string[];
  constructor(unsupportedFields: string[]) {
    super(
      `kafka-plugin extension schema contains non-scalar field(s): ${unsupportedFields.join(', ')}. ` +
        'Extensions must use scalar fields so discovery can round-trip them.',
    );
    this.name = 'ExtensionSchemaUnsupportedFieldError';
    this.unsupportedFields = unsupportedFields;
  }
}

export function validateExtensionAgainstCore<TParsed>(
  extension: KafkaPluginExtension<TParsed>,
  coreSchema: ZodObject<ZodRawShape>,
): void {
  const extShape = extension.schema.shape;
  if (!extShape || typeof extShape !== 'object') {
    throw new TypeError('kafka-plugin extension.schema must be a Zod object schema (has .shape)');
  }
  const catchall = extension.schema._def.catchall;
  if (catchall && !(catchall instanceof z.ZodNever)) {
    throw new ExtensionSchemaUnsupportedFieldError(['*']);
  }
  const coreKeys = new Set(Object.keys(coreSchema.shape));
  const colliding = Object.keys(extShape).filter((k) => coreKeys.has(k));
  if (colliding.length > 0) {
    throw new ExtensionSchemaCollisionError(colliding);
  }

  const unsupported = Object.entries(extShape)
    .filter(([, fieldSchema]) => !isSupportedScalarField(fieldSchema))
    .map(([field]) => field);
  if (unsupported.length > 0) {
    throw new ExtensionSchemaUnsupportedFieldError(unsupported);
  }
}

function isSupportedScalarField(schema: ZodTypeAny): boolean {
  if (hasNullableWrapper(schema)) return false;
  const unwrapped = unwrapScalarWrapper(schema);
  return (
    unwrapped instanceof z.ZodString ||
    unwrapped instanceof z.ZodNumber ||
    unwrapped instanceof z.ZodBoolean ||
    unwrapped instanceof z.ZodEnum ||
    unwrapped instanceof z.ZodNativeEnum ||
    (
      unwrapped instanceof z.ZodLiteral &&
      isNonNullScalar((unwrapped as z.ZodLiteral<unknown>)._def.value)
    )
  );
}

function isNonNullScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function hasNullableWrapper(schema: ZodTypeAny): boolean {
  let current = schema;
  while (true) {
    if (current instanceof z.ZodNullable) return true;
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault || current instanceof z.ZodCatch) {
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodEffects && current._def.effect.type === 'refinement') {
      current = current._def.schema;
      continue;
    }
    return false;
  }
}

function unwrapScalarWrapper(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  while (true) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault || current instanceof z.ZodCatch) {
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodEffects && current._def.effect.type === 'refinement') {
      current = current._def.schema;
      continue;
    }
    return current;
  }
}
