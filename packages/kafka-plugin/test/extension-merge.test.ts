import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  validateExtensionAgainstCore,
  ExtensionSchemaCollisionError,
  ExtensionSchemaUnsupportedFieldError,
  type KafkaPluginExtension,
} from '../src/extension.js';
import { coreSchema, CORE_FIELDS } from '../src/schema.js';
describe('validateExtensionAgainstCore — boot-time collision', () => {
  it.each(CORE_FIELDS.map((k) => [k]))(
    'throws ExtensionSchemaCollisionError when extension redeclares core key %s',
    (coreKey) => {
      const ext: KafkaPluginExtension<Record<string, unknown>> = {
        schema: z.object({ [coreKey]: z.string() }),
        augment: () => ({}),
      };
      expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
        ExtensionSchemaCollisionError,
      );
      try {
        validateExtensionAgainstCore(ext, coreSchema);
      } catch (err) {
        expect(err).toBeInstanceOf(ExtensionSchemaCollisionError);
        expect((err as ExtensionSchemaCollisionError).collidingKeys).toContain(coreKey);
        expect((err as Error).message).toContain(coreKey as string);
      }
    },
  );
  it('lists every overlapping key in the error message and collidingKeys', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({ name: z.string(), kafkaTopicName: z.string(), extra: z.string() }),
      augment: () => ({}),
    };
    try {
      validateExtensionAgainstCore(ext, coreSchema);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionSchemaCollisionError);
      const e = err as ExtensionSchemaCollisionError;
      expect(e.collidingKeys).toEqual(expect.arrayContaining(['name', 'kafkaTopicName']));
      expect(e.collidingKeys).not.toContain('extra');
      expect(e.message).toContain('name');
      expect(e.message).toContain('kafkaTopicName');
    }
  });
  it('passes silently for a clean extension whose keys do not overlap core', () => {
    const ext: KafkaPluginExtension<{ externalRef: string; sourceRef: string }> = {
      schema: z.object({ externalRef: z.string(), sourceRef: z.string() }),
      augment: (p) => ({ 'x:externalRef': p.externalRef, 'x:sourceRef': p.sourceRef }),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).not.toThrow();
  });
  it('rejects nested/object-valued extension fields because discovery cannot round-trip them', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({ nested: z.object({ value: z.string() }) }),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
      ExtensionSchemaUnsupportedFieldError,
    );
  });
  it('rejects catchall extension schemas that would allow arbitrary request keys', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({}).catchall(z.string()),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
      ExtensionSchemaUnsupportedFieldError,
    );
  });
  it('allows optional scalar extension fields', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({ externalRef: z.string().optional() }),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).not.toThrow();
  });
  it('rejects nullable scalar extension fields because KA merge cannot round-trip null', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({
        externalRef: z.string().nullable(),
        maybeScore: z.number().nullish(),
      }),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
      ExtensionSchemaUnsupportedFieldError,
    );
  });
  it('rejects literal null extension fields because KA merge cannot round-trip null', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({ externalRef: z.literal(null) }),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
      ExtensionSchemaUnsupportedFieldError,
    );
  });
  it('rejects transformed fields because scalar input may parse to non-scalar output', () => {
    const ext: KafkaPluginExtension<Record<string, unknown>> = {
      schema: z.object({ externalRef: z.string().transform(() => ({ nested: true })) }),
      augment: () => ({}),
    };
    expect(() => validateExtensionAgainstCore(ext, coreSchema)).toThrow(
      ExtensionSchemaUnsupportedFieldError,
    );
  });
});
import { z as z2 } from 'zod';
import { createKafkaPlugin } from '../src/index.js';
describe('createKafkaPlugin — extension wiring', () => {
  it('throws ExtensionSchemaCollisionError at factory call time when extension collides with core', () => {
    expect(() =>
      createKafkaPlugin({
        contextGraphId: 'urn:cg:demo',
        extension: {
          schema: z2.object({ name: z2.string() }),
          augment: () => ({}),
        },
      }),
    ).toThrow(ExtensionSchemaCollisionError);
  });
  it('returns a plugin when extension is clean', () => {
    const plugin = createKafkaPlugin({
      contextGraphId: 'urn:cg:demo',
      extension: {
        schema: z2.object({ externalRef: z2.string() }),
        augment: (p: { externalRef: string }) => ({ 'x:externalRef': p.externalRef }),
      },
    });
    expect(plugin.name).toBe('kafka-plugin');
    expect(typeof plugin.handle).toBe('function');
  });
});
// Bug 1: ADR 0004 lets extensions ADD secondary `@type` entries and ADD new
// `@context` prefixes. The blanket "core wins, drop everything" rule was
// wrong for these two keys specifically.
import { buildKa, mergeAugmentFragment } from '../src/ka-builder.js';
import { coreSchema as baseSchema } from '../src/schema.js';
describe('mergeAugmentFragment — Bug 1: @type multi-type union', () => {
  const baseInputs = { name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' };
  it('unions a scalar extension @type with the baseline as a deduped array', () => {
    const base = buildKa(baseSchema.parse(baseInputs));
    const merged = mergeAugmentFragment(
      base,
      { '@type': 'source:StreamingSource' },
      new Set<string>(),
    );
    expect(merged['@type']).toEqual([
      'dkg-streams:KafkaStream',
      'source:StreamingSource',
    ]);
  });
  it('unions an array extension @type with the baseline, baseline first, dedupe', () => {
    const base = buildKa(baseSchema.parse(baseInputs));
    const merged = mergeAugmentFragment(
      base,
      { '@type': ['source:StreamingSource', 'vendor:TelemetryFeed'] },
      new Set<string>(),
    );
    expect(merged['@type']).toEqual([
      'dkg-streams:KafkaStream',
      'source:StreamingSource',
      'vendor:TelemetryFeed',
    ]);
  });
  it('deduplicates when extension repeats the baseline @type', () => {
    const base = buildKa(baseSchema.parse(baseInputs));
    const merged = mergeAugmentFragment(
      base,
      { '@type': ['dkg-streams:KafkaStream', 'source:StreamingSource'] },
      new Set<string>(),
    );
    expect(merged['@type']).toEqual([
      'dkg-streams:KafkaStream',
      'source:StreamingSource',
    ]);
  });
  it('does not log a collision warning for @type — multi-type is the contract', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = buildKa(baseSchema.parse(baseInputs));
    mergeAugmentFragment(
      base,
      { '@type': 'source:StreamingSource' },
      new Set<string>(),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    const reserved = mergeAugmentFragment(base, { '@id': 'urn:extension-owned-root' }, new Set<string>());
    expect(reserved).not.toHaveProperty('@id');
    warnSpy.mockRestore();
  });
});
describe('mergeAugmentFragment — Bug 1: @context object-merge', () => {
  const baseInputs = { name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' };
  it('merges new extension @context prefixes onto the baseline context', () => {
    const base = buildKa(baseSchema.parse(baseInputs));
    const merged = mergeAugmentFragment(
      base,
      { '@context': { vendor: 'https://vendor.example.com/ontology#' } },
      new Set<string>(),
    );
    expect(merged['@context']).toEqual({
      'dkg-streams': 'https://ontology.dkg.io/streams#',
      schema: 'https://schema.org/',
      vendor: 'https://vendor.example.com/ontology#',
    });
  });
  it('keeps core prefix mapping when extension tries to redefine dkg-streams (core wins + warn once)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = buildKa(baseSchema.parse(baseInputs));
    const logged = new Set<string>();
    const merged = mergeAugmentFragment(
      base,
      {
        '@context': {
          'dkg-streams': 'https://evil.example/streams#',
          vendor: 'https://vendor.example.com/ontology#',
        },
      },
      logged,
    );
    expect((merged['@context'] as Record<string, string>)['dkg-streams']).toBe(
      'https://ontology.dkg.io/streams#',
    );
    expect((merged['@context'] as Record<string, string>).vendor).toBe(
      'https://vendor.example.com/ontology#',
    );
    const messages = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(messages.some((m) => m.includes('@context') && m.includes('dkg-streams'))).toBe(true);
    warnSpy.mockRestore();
  });
  it('drops the extension @context entirely if it is not an object (defensive)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = buildKa(baseSchema.parse(baseInputs));
    const merged = mergeAugmentFragment(
      base,
      { '@context': 'https://broken-extension.example/' as unknown as Record<string, string> },
      new Set<string>(),
    );
    expect(merged['@context']).toEqual(base['@context']);
    warnSpy.mockRestore();
  });
});

describe('scalar extension wrappers and defensive merge boundaries', () => {
  it.each([
    ['default', z.string().default('fallback'), undefined, 'fallback'],
    ['catch', z.number().catch(7), 'invalid number', 7],
    ['refinement', z.string().refine(value => value.startsWith('safe-')), 'safe-value', 'safe-value'],
    ['native enum', z.nativeEnum({ Ready: 'ready', Busy: 'busy' } as const), 'ready', 'ready'],
    ['number literal', z.literal(42), 42, 42],
    ['boolean literal', z.literal(false), false, false],
  ])('accepts a %s wrapper that still produces scalar fields', (_name, field, input, expected) => {
    const schema = z.object({ extra: field as z.ZodTypeAny });
    expect(() => validateExtensionAgainstCore({ schema, augment: () => ({}) }, coreSchema)).not.toThrow();
    expect(schema.parse({ extra: input })).toEqual({ extra: expected });
  });

  it.each([
    z.string().nullable().default(null),
    z.string().nullable().catch(null),
    z.string().nullable().refine(() => true).optional(),
  ])('rejects null hidden inside scalar wrappers', field => {
    expect(() => validateExtensionAgainstCore({ schema: z.object({ hidden: field }), augment: () => ({}) }, coreSchema))
      .toThrow(ExtensionSchemaUnsupportedFieldError);
  });

  it('rejects a non-object extension schema at the public validation boundary', () => {
    const extension = { schema: z.string(), augment: () => ({}) } as unknown as KafkaPluginExtension<unknown>;
    expect(() => validateExtensionAgainstCore(extension, coreSchema)).toThrow('must be a Zod object schema');
  });

  it('deduplicates an already multi-type KA and ignores invalid extension metadata', () => {
    const base = { ...buildKa(baseSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' })),
      '@type': ['dkg-streams:KafkaStream', 'vendor:Stream', 'vendor:Stream'] };
    const before = structuredClone(base);
    expect(mergeAugmentFragment(base, { '@type': { invalid: true }, '@context': null }, new Set())['@type'])
      .toEqual(['dkg-streams:KafkaStream', 'vendor:Stream']);
    const merged = mergeAugmentFragment(base, { '@type': [false, 'vendor:Stream', 'vendor:Extra'],
      '@context': { invalid: 42, vendor: 'https://vendor.example/' } }, new Set());
    expect(merged['@type']).toEqual(['dkg-streams:KafkaStream', 'vendor:Stream', 'vendor:Extra']);
    expect(merged['@context']).toEqual({ ...base['@context'], vendor: 'https://vendor.example/' });
    expect(base).toEqual(before);
  });

  it('logs repeated unsupported values and core collisions once across registrations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = buildKa(baseSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }));
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const merged = mergeAugmentFragment(base, { nested: { secret: 'ignored' }, 'schema:name': 'overwrite',
          '@context': ['not-a-context'], enabled: false, count: 0 }, seen);
        expect(merged).toEqual({ ...base, enabled: false, count: 0 });
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join('\n')).toContain('non-scalar key "nested"');
      expect(warn.mock.calls.flat().join('\n')).toContain('colliding key "schema:name"');
    } finally { warn.mockRestore(); }
  });
});

it('preserves a scalar @type when an extension only repeats the baseline type', () => {
  const base = buildKa(baseSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }));
  expect(mergeAugmentFragment(base, { '@type': ['dkg-streams:KafkaStream'] }, new Set())['@type'])
    .toBe('dkg-streams:KafkaStream');
});
