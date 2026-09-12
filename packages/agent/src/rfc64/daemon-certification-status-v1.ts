// SPDX-License-Identifier: Apache-2.0

export const RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1 =
  'dkg-rfc64-daemon-certification-status-v1' as const;

interface Codec<Input, Output> {
  project(input: Input, path: string): Output;
  decode(input: unknown, path: string): Output;
}

type InputOf<T> = T extends Codec<infer Input, unknown> ? Input : never;
type OutputOf<T> = T extends Codec<unknown, infer Output> ? Output : never;
type CodecFields = Readonly<Record<string, Codec<unknown, unknown>>>;
type CodecInput<Fields extends CodecFields> = Readonly<{
  [Key in keyof Fields]: InputOf<Fields[Key]>;
}>;
type CodecOutput<Fields extends CodecFields> = Readonly<{
  [Key in keyof Fields]: OutputOf<Fields[Key]>;
}>;

const stringCodec = scalarCodec<string>((input, path) => {
  if (typeof input !== 'string') malformed(path, 'string');
  return input;
});
const nonEmptyStringCodec = scalarCodec<string>((input, path) => {
  if (typeof input !== 'string' || input.length === 0) {
    malformed(path, 'non-empty string');
  }
  return input;
});
const booleanCodec = scalarCodec<boolean>((input, path) => {
  if (typeof input !== 'boolean') malformed(path, 'boolean');
  return input;
});
const numberCodec = scalarCodec<number>((input, path) => {
  if (typeof input !== 'number') malformed(path, 'number');
  return input;
});
const canonicalStringCodec: Codec<string | number, string> = Object.freeze({
  project(input: string | number, path: string) {
    if (typeof input !== 'string' && typeof input !== 'number') {
      malformed(path, 'string or number');
    }
    return String(input);
  },
  decode(input: unknown, path: string) {
    return stringCodec.decode(input, path);
  },
});
const rolloutModeCodec = enumCodec(['legacy', 'shadow', 'catalog'] as const);
const phaseCodec = enumCodec([
  'inactive',
  'resolving-authority',
  'bootstrapping',
  'applying',
  'blocked',
  'known-incomplete',
  'unknown-freshness',
  'complete',
] as const);
const authorityStateCodec = enumCodec([
  'inactive',
  'resolving',
  'accepted',
  'blocked',
] as const);
const authorityFreshnessCodec = nullableCodec(enumCodec(['current', 'unknown'] as const));
const nullableStringCodec = nullableCodec(stringCodec);

const operationalStatusCodec = recordCodec({
  contextGraphId: nonEmptyStringCodec,
  effectiveMode: rolloutModeCodec,
  legacySyncAllowed: booleanCodec,
  phase: phaseCodec,
  authorityState: authorityStateCodec,
  authorityFreshness: authorityFreshnessCodec,
  catalogServiceStarted: booleanCodec,
  expectedCatalogHeadDigest: nullableStringCodec,
  appliedCatalogHeadDigest: nullableStringCodec,
  expectedInventoryDigest: nullableStringCodec,
  appliedInventoryDigest: nullableStringCodec,
  expectedRowCount: nullableStringCodec,
  appliedRowCount: nullableStringCodec,
  missingRowCount: nullableStringCodec,
  catalogVersion: nullableStringCodec,
  lastSuccessfulAdvanceAt: nullableStringCodec,
});

const daemonCertificationStatusCodec = recordCodec({
  schema: literalCodec(RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1),
  daemonIdentity: nonEmptyStringCodec,
  commit: nullableStringCodec,
  networkId: stringCodec,
  syncReconcilerEnabled: booleanCodec,
  chain: nullableCodec(recordCodec({
    configured: booleanCodec,
    rpcEndpointCount: numberCodec,
    chainId: nullableCodec(canonicalStringCodec),
  })),
  catalog: recordCodec({
    enabled: booleanCodec,
    killSwitch: booleanCodec,
    contextGraphModes: dictionaryCodec(rolloutModeCodec),
    contextGraphs: uniqueContextGraphsCodec(arrayCodec(operationalStatusCodec)),
  }),
});

export type Rfc64DaemonCertificationOperationalStatusV1 =
  OutputOf<typeof operationalStatusCodec>;
export type Rfc64DaemonCertificationStatusV1 =
  OutputOf<typeof daemonCertificationStatusCodec>;
export type CreateRfc64DaemonCertificationStatusInputV1 =
  Omit<InputOf<typeof daemonCertificationStatusCodec>, 'schema'>;
export const RFC64_DAEMON_CERTIFICATION_COMPLETE_PARITY_KEYS_V1 = Object.freeze([
  'expectedCatalogHeadDigest',
  'appliedCatalogHeadDigest',
  'expectedInventoryDigest',
  'appliedInventoryDigest',
  'expectedRowCount',
  'appliedRowCount',
  'missingRowCount',
  'catalogVersion',
] as const satisfies readonly (keyof Rfc64DaemonCertificationOperationalStatusV1)[]);

/**
 * Build the narrow, non-secret `/api/status` projection consumed by release
 * certification. Projection and decoding share the same typed codec so a wire
 * field cannot be added to one side without becoming required on the other.
 */
export function createRfc64DaemonCertificationStatusV1(
  input: CreateRfc64DaemonCertificationStatusInputV1,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  return daemonCertificationStatusCodec.project({
    ...input,
    schema: RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
  }, '$');
}

/** Decode and detach an untrusted JSON value returned by the daemon status endpoint. */
export function decodeRfc64DaemonCertificationStatusV1(
  input: unknown,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  return daemonCertificationStatusCodec.decode(input, '$');
}

function scalarCodec<Value>(
  validate: (input: unknown, path: string) => Value,
): Codec<Value, Value> {
  return Object.freeze({
    project(input: Value, path: string) {
      return validate(input, path);
    },
    decode: validate,
  });
}

function literalCodec<const Value extends string>(value: Value): Codec<Value, Value> {
  return scalarCodec((input, path) => {
    if (input !== value) malformed(path, JSON.stringify(value));
    return value;
  });
}

function enumCodec<const Values extends readonly string[]>(
  values: Values,
): Codec<Values[number], Values[number]> {
  return scalarCodec((input, path) => {
    if (typeof input !== 'string' || !values.includes(input)) {
      malformed(path, values.join(' | '));
    }
    return input as Values[number];
  });
}

function nullableCodec<Input, Output>(
  codec: Codec<Input, Output>,
): Codec<Input | null, Output | null> {
  return Object.freeze({
    project(input: Input | null, path: string) {
      return input === null ? null : codec.project(input, path);
    },
    decode(input: unknown, path: string) {
      return input === null ? null : codec.decode(input, path);
    },
  });
}

function arrayCodec<Input, Output>(
  codec: Codec<Input, Output>,
): Codec<readonly Input[], readonly Readonly<Output>[]> {
  return Object.freeze({
    project(input: readonly Input[], path: string) {
      if (!Array.isArray(input)) malformed(path, 'array');
      return Object.freeze(input.map((value, index) => (
        codec.project(value, `${path}[${index}]`)
      )));
    },
    decode(input: unknown, path: string) {
      if (!Array.isArray(input)) malformed(path, 'array');
      return Object.freeze(input.map((value, index) => (
        codec.decode(value, `${path}[${index}]`)
      )));
    },
  });
}

function dictionaryCodec<Input, Output>(
  codec: Codec<Input, Output>,
): Codec<Readonly<Record<string, Input>>, Readonly<Record<string, Output>>> {
  return Object.freeze({
    project(input: Readonly<Record<string, Input>>, path: string) {
      return transformDictionary(input, path, (value, valuePath) => (
        codec.project(value as Input, valuePath)
      ));
    },
    decode(input: unknown, path: string) {
      return transformDictionary(input, path, codec.decode.bind(codec));
    },
  });
}

function transformDictionary<Output>(
  input: unknown,
  path: string,
  transform: (value: unknown, path: string) => Output,
): Readonly<Record<string, Output>> {
  const source = record(input, path);
  const output: Record<string, Output> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    nonEmptyStringCodec.decode(key, `${path} key`);
    output[key] = transform(value, `${path}.${key}`);
  }
  return Object.freeze(output);
}

function recordCodec<const Fields extends CodecFields>(
  fields: Fields,
): Codec<CodecInput<Fields>, CodecOutput<Fields>> {
  const transform = (
    input: unknown,
    path: string,
    operation: 'project' | 'decode',
  ): CodecOutput<Fields> => {
    const source = record(input, path);
    const output: Record<string, unknown> = {};
    for (const [key, codec] of Object.entries(fields)) {
      output[key] = codec[operation](source[key], `${path}.${key}`);
    }
    // CodecOutput is derived from `fields`; this is the single dynamic-key
    // bridge, rather than an assertion of a separately maintained DTO.
    return Object.freeze(output) as CodecOutput<Fields>;
  };
  return Object.freeze({
    project(input: CodecInput<Fields>, path: string) {
      return transform(input, path, 'project');
    },
    decode(input: unknown, path: string) {
      return transform(input, path, 'decode');
    },
  });
}

function uniqueContextGraphsCodec<Input extends Readonly<{ contextGraphId: string }>>(
  codec: Codec<readonly Input[], readonly Input[]>,
): Codec<readonly Input[], readonly Input[]> {
  const unique = (statuses: readonly Input[], path: string) => {
    const contextGraphIds = new Set<string>();
    for (const [index, status] of statuses.entries()) {
      if (contextGraphIds.has(status.contextGraphId)) {
        malformed(`${path}[${index}].contextGraphId`, 'unique context graph ID');
      }
      contextGraphIds.add(status.contextGraphId);
    }
    return statuses;
  };
  return Object.freeze({
    project(input: readonly Input[], path: string) {
      return unique(codec.project(input, path), path);
    },
    decode(input: unknown, path: string) {
      return unique(codec.decode(input, path), path);
    },
  });
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    malformed(path, 'object');
  }
  return input as Record<string, unknown>;
}

function malformed(path: string, expected: string): never {
  throw new TypeError(`Invalid RFC-64 daemon certification status at ${path}; expected ${expected}`);
}
