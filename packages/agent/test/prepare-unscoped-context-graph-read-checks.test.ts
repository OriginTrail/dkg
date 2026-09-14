import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphCatalogUri,
  contextGraphDataUri, contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { LOCAL_ID, NAME_HASH, selectedFixture } from './context-graph-registration-binding.fixture.js';
import { createContextGraphRegistrationReadPlan } from
  '../src/context-graph-registration-read-plan.js';
import {
  resolveContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityInput,
} from '../src/context-graph-read-authority.js';
import {
  prepareUnscopedContextGraphReadChecks,
  type UnscopedContextGraphReadCheckDependencies,
} from '../src/prepare-unscoped-context-graph-read-checks.js';

const commitment = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id));

function dependencies() {
  const inputs = new Map<string, Partial<ContextGraphReadAuthorityInput>>();
  const getRegisteredAuthority = vi.fn<(id: string) => ReturnType<ContextGraphReadAuthorityInput['getRegisteredAuthority']>>(
    async () => ({ kind: 'unregistered' }),
  );
  const isPrivateLocalGraph = vi.fn<(id: string) => Promise<boolean>>(async () => true);
  const registrationNameHash = vi.fn<(id: string) => string | undefined>(commitment);
  const findContextGraphIdsWithReadAuthorityFacts = vi.fn<(
    ids: readonly string[], signal: AbortSignal,
  ) => Promise<ReadonlySet<string>>>(async () => new Set<string>());
  const readMetadataRevision = vi.fn(() => 0);
  const resolveContextGraphIdsByNameHashes = vi.fn<(
    names: readonly string[], options: { signal?: AbortSignal },
  ) => Promise<ReadonlyMap<string, bigint | null>>>(async (names) => (
      new Map(names.map((name) => [name, null]))
    ));
  const deps = {
    inputs, getRegisteredAuthority, isPrivateLocalGraph,
    createReadAuthorityInput: vi.fn<UnscopedContextGraphReadCheckDependencies['createReadAuthorityInput']>((id) => ({
      contextGraphId: id, callerAgentAddress: 'outsider', allowSubscriptionFallback: true,
      isSystemContextGraph: false, getPeerId: () => 'peer-outsider',
      getAllowedPeers: async () => null,
      getRegisteredAuthority: () => getRegisteredAuthority(id),
      isAgentAllowed: (agent, roster) => agent !== undefined && roster.includes(agent),
      hasLocalAgentInRoster: (roster) => roster.includes('outsider'),
      resolveRfc64PrivateRoster: () => undefined,
      hasAcceptedRfc64PublicPolicy: false, isPendingMetadata: false,
      isPrivateLocalGraph: () => isPrivateLocalGraph(id),
      getLocalAgentGate: async () => null, getLegacyParticipants: async () => null,
      hasLegacySubscription: false, getLocalIdentityId: async () => 0n,
      ...inputs.get(id),
    })),
    registrationNameHash,
    findContextGraphIdsWithReadAuthorityFacts,
    readMetadataRevision,
    resolveContextGraphIdsByNameHashes,
    prepareRegistrationReadPlan: vi.fn<UnscopedContextGraphReadCheckDependencies['prepareRegistrationReadPlan']>(
      (ids, signal) => createContextGraphRegistrationReadPlan({
        nameHashForBatch: registrationNameHash,
        resolveByNameHashes: (names, options) => resolveContextGraphIdsByNameHashes(names, options),
      }, ids, signal),
    ),
    prepareReadAuthorityFactsSnapshot: vi.fn<UnscopedContextGraphReadCheckDependencies['prepareReadAuthorityFactsSnapshot']>(
      async (ids, signal) => {
        const revision = readMetadataRevision();
        const present = new Set(await findContextGraphIdsWithReadAuthorityFacts(ids, signal));
        return {
          assertCurrent: () => readMetadataRevision() === revision,
          isAbsent: (id) => !present.has(id),
        };
      },
    ),
  };
  return deps;
}

describe('prepared unscoped Context Graph read checks', () => {
  it.each(['unchanged', 'local-route', 'changed-hash'])(
    'denies a stale scalar miss after a positive batch despite %s routing', async (route) => {
      const deps = dependencies();
      deps.resolveContextGraphIdsByNameHashes.mockResolvedValue(new Map([[commitment('registered'), 7n]]));
      deps.isPrivateLocalGraph.mockResolvedValue(false);
      deps.inputs.set('registered', { hasAcceptedRfc64PublicPolicy: true });
      const signal = new AbortController().signal;
      const check = await prepareUnscopedContextGraphReadChecks(deps, ['registered'], signal);
      if (route === 'local-route') deps.registrationNameHash.mockReturnValue(undefined);
      if (route === 'changed-hash') deps.registrationNameHash.mockReturnValue(commitment('other'));
      expect(await check('registered', signal)).toBe(false);
      expect(deps.getRegisteredAuthority).toHaveBeenCalledOnce();
      expect(deps.isPrivateLocalGraph).not.toHaveBeenCalled();
    },
  );

  it.each(['public', 'private'] as const)('denies a conflicting scalar %s binding after a positive batch', async (kind) => {
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockResolvedValue(new Map([[commitment('registered'), 7n]]));
    deps.getRegisteredAuthority.mockResolvedValue(kind === 'public'
      ? { kind, onChainId: 8n }
      : { kind, onChainId: 8n, participantAgents: ['outsider'] });
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['registered'], signal);
    expect(await check('registered', signal)).toBe(false);
  });

  it.each(['public', 'member', 'outsider', 'unavailable'] as const)(
    'retains canonical %s authority for a matching positive binding', async (authority) => {
      const deps = dependencies();
      deps.resolveContextGraphIdsByNameHashes.mockResolvedValue(new Map([[commitment('registered'), 7n]]));
      deps.getRegisteredAuthority.mockResolvedValue(authority === 'public'
        ? { kind: 'public', onChainId: 7n }
        : authority === 'unavailable'
          ? { kind: 'unavailable', onChainId: 7n, reason: 'chain-access-policy-unavailable' }
          : { kind: 'private', onChainId: 7n, participantAgents: [authority === 'member' ? 'outsider' : 'owner'] });
      const signal = new AbortController().signal;
      const check = await prepareUnscopedContextGraphReadChecks(deps, ['registered'], signal);
      expect(await check('registered', signal)).toBe(authority === 'public' || authority === 'member');
      expect(deps.getRegisteredAuthority).toHaveBeenCalledOnce();
      expect(deps.isPrivateLocalGraph).not.toHaveBeenCalled();
    },
  );

  it('uses a complete bulk proof for more than 512 ordinary KA interpretations', async () => {
    const ids = Array.from({ length: 650 }, (_, i) => `public/_verifiable_memory/author/${i}`);
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ids, signal);
    expect(await Promise.all(ids.map((id) => check(id, signal)))).toEqual(ids.map(() => true));
    expect(deps.resolveContextGraphIdsByNameHashes).toHaveBeenCalledTimes(1);
    expect(deps.resolveContextGraphIdsByNameHashes.mock.calls[0][0]).toHaveLength(650);
    expect(deps.createReadAuthorityInput).toHaveBeenCalledTimes(650);
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
    expect(deps.isPrivateLocalGraph).not.toHaveBeenCalled();
  });

  it('keeps non-name routes and unknown checker IDs on the original canonical inputs', async () => {
    const individual = new Set(['known', '42', 'current-binding', 'wire-alias']);
    const deps = dependencies();
    deps.registrationNameHash.mockImplementation((id) => individual.has(id) ? undefined : commitment(id));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, [...individual, 'ordinary'], signal);
    for (const id of individual) expect(await check(id, signal)).toBe(false);
    expect(await check('ordinary', signal)).toBe(true);
    expect(await check('not-in-prepared-request', signal)).toBe(false);
    expect(deps.resolveContextGraphIdsByNameHashes.mock.calls[0][0]).toEqual([commitment('ordinary')]);
    expect(deps.getRegisteredAuthority).toHaveBeenCalledTimes(individual.size + 1);
  });

  it('retains positive registration and metadata-only private gates beyond the previous cutoff', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `public/partition/${i}`);
    const registered = ids[599];
    const privateGate = ids[598];
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => (
      new Map(names.map((name) => [name, name === commitment(registered) ? 9n : null]))
    ));
    deps.findContextGraphIdsWithReadAuthorityFacts.mockResolvedValue(new Set([privateGate]));
    deps.getRegisteredAuthority.mockImplementation(async (id) => id === registered
      ? { kind: 'private', onChainId: 9n, participantAgents: ['owner'] }
      : { kind: 'unregistered' });
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ids, signal);
    expect(await check(registered, signal)).toBe(false);
    expect(await check(privateGate, signal)).toBe(false);
    expect(await check(ids[0], signal)).toBe(true);
    expect(deps.getRegisteredAuthority.mock.calls.map(([id]) => id)).toEqual([registered]);
    expect(deps.isPrivateLocalGraph.mock.calls.map(([id]) => id)).toEqual([privateGate]);
  });

  it.each(['local-state', 'name-hash', 'metadata-revision'])('rechecks %s after preparation', async (change) => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['candidate'], signal);
    if (change === 'local-state') deps.registrationNameHash.mockReturnValue(undefined);
    else if (change === 'name-hash') deps.registrationNameHash.mockReturnValue(commitment('changed-binding'));
    else deps.readMetadataRevision.mockReturnValue(1);
    expect(await check('candidate', signal)).toBe(false);
    expect(deps.isPrivateLocalGraph).toHaveBeenCalledOnce();
  });

  it('uses the registry boundary for system, local, wire and numeric precedence', async () => {
    const { agent, subscription } = selectedFixture();
    const ids = [SYSTEM_CONTEXT_GRAPHS.AGENTS, LOCAL_ID, NAME_HASH, '42', 'cold-name'];
    const signal = new AbortController().signal;
    const resolveBatch = vi.fn(async (names: readonly string[]) => (
      new Map(names.map((name) => [name, null]))
    ));
    (agent.chain as any).resolveContextGraphIdsByNameHashes = resolveBatch;
    agent.contextGraphNameCommitment = commitment;
    const plan = await agent.prepareContextGraphRegistrationReadPlan(ids, {
      signal,
    });
    expect(plan?.contextGraphIds).toEqual(['cold-name']);
    const preparation = await plan!.prepare(signal);
    expect(preparation.kind).toBe('ready');
    const { prepared } = preparation;
    expect(resolveBatch.mock.calls[0][0]).toEqual([commitment('cold-name')]);
    const live = vi.fn(async () => ({ kind: 'unregistered' as const }));
    for (const id of [SYSTEM_CONTEXT_GRAPHS.AGENTS, LOCAL_ID, NAME_HASH, '42']) {
      expect(await prepared.resolve(id, live, signal)).toEqual({
        authority: { kind: 'unregistered' },
        metadataAbsenceEligible: false,
      });
    }
    expect(live).toHaveBeenCalledTimes(4);
    expect(await prepared.resolve('cold-name', live, signal)).toEqual({
      authority: { kind: 'unregistered' },
      metadataAbsenceEligible: true,
    });
    expect(live).toHaveBeenCalledTimes(4);
    // A newly selected invalid binding cannot consume an earlier cold absence.
    agent.subscribedContextGraphs.set('cold-name', { ...subscription, onChainId: 'invalid' });
    expect(await prepared.resolve('cold-name', live, signal)).toEqual({
      authority: { kind: 'unregistered' },
      metadataAbsenceEligible: false,
    });
    expect(live).toHaveBeenCalledTimes(5);
  });

  it('keeps scalar registration and restrictive metadata when bulk reads are unavailable', async () => {
    const deps = dependencies();
    deps.prepareRegistrationReadPlan.mockResolvedValue(null);
    deps.findContextGraphIdsWithReadAuthorityFacts.mockResolvedValue(new Set(['a']));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    expect(await check('a', signal)).toBe(false);
    expect(deps.findContextGraphIdsWithReadAuthorityFacts).toHaveBeenCalledOnce();
    expect(deps.getRegisteredAuthority).toHaveBeenCalledOnce();
    expect(deps.isPrivateLocalGraph).toHaveBeenCalledOnce();
  });

  it('prepares more than 1,000 scalar-only public candidates concurrently', async () => {
    const ids = Array.from({ length: 1_025 }, (_, index) => `public/scalar/${index}`);
    const deps = dependencies();
    deps.prepareRegistrationReadPlan.mockResolvedValue(null);
    let active = 0;
    let peak = 0;
    deps.getRegisteredAuthority.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { kind: 'unregistered' };
    });
    deps.isPrivateLocalGraph.mockResolvedValue(false);
    const signal = new AbortController().signal;

    const check = await prepareUnscopedContextGraphReadChecks(deps, ids, signal);
    expect(await Promise.all(ids.map((id) => check(id, signal)))).toEqual(ids.map(() => true));
    expect(deps.getRegisteredAuthority).toHaveBeenCalledTimes(ids.length);
    expect(peak).toBeGreaterThan(4);
    expect(peak).toBeLessThanOrEqual(32);
    expect(deps.findContextGraphIdsWithReadAuthorityFacts).toHaveBeenCalledOnce();
    expect(deps.isPrivateLocalGraph).not.toHaveBeenCalled();
  });

  const canonicalCases: Array<{
    name: string;
    input: Partial<ContextGraphReadAuthorityInput>;
    allowed: boolean;
    registered?: boolean;
    metadata?: boolean;
  }> = [
    { name: 'system', input: { isSystemContextGraph: true }, allowed: true },
    { name: 'registered public precedes pending metadata', input: {
      getRegisteredAuthority: async () => ({ kind: 'public', onChainId: 7n }), isPendingMetadata: true,
    }, registered: true, allowed: true },
    { name: 'registered private precedes accepted public', input: {
      getRegisteredAuthority: async () => ({ kind: 'private', onChainId: 7n, participantAgents: ['owner'] }),
      hasAcceptedRfc64PublicPolicy: true,
    }, registered: true, allowed: false },
    { name: 'registered private retains peer restriction', input: {
      getRegisteredAuthority: async () => ({ kind: 'private', onChainId: 7n, participantAgents: ['outsider'] }),
      getAllowedPeers: async () => ['other-peer'],
    }, registered: true, allowed: false },
    { name: 'unavailable registration precedes accepted public', input: {
      getRegisteredAuthority: async () => ({ kind: 'unavailable', reason: 'chain-name-binding-unavailable' }),
      hasAcceptedRfc64PublicPolicy: true,
    }, registered: true, allowed: false },
    { name: 'live RFC64 missing roster', input: { resolveRfc64PrivateRoster: () => null }, allowed: false },
    { name: 'live RFC64 outsider', input: { resolveRfc64PrivateRoster: () => ['owner'] }, allowed: false },
    { name: 'live RFC64 participant', input: { resolveRfc64PrivateRoster: () => ['outsider'] }, allowed: true },
    { name: 'accepted public precedes pending metadata', input: {
      hasAcceptedRfc64PublicPolicy: true, isPendingMetadata: true,
    }, allowed: true },
    { name: 'pending metadata', input: { isPendingMetadata: true }, allowed: false },
    { name: 'local public', input: { isPrivateLocalGraph: async () => false }, allowed: true },
    { name: 'local agent gate', input: { getLocalAgentGate: async () => ['owner'] }, metadata: true, allowed: false },
    { name: 'local agent and peer gate', input: {
      getLocalAgentGate: async () => ['outsider'], getAllowedPeers: async () => ['other-peer'],
    }, metadata: true, allowed: false },
    { name: 'legacy subscription', input: { hasLegacySubscription: true }, metadata: true, allowed: true },
    { name: 'disabled legacy subscription fallback', input: {
      hasLegacySubscription: true, allowSubscriptionFallback: false,
    }, metadata: true, allowed: false },
    { name: 'legacy identity participant', input: {
      getLegacyParticipants: async () => ['42'], getLocalIdentityId: async () => 42n,
    }, metadata: true, allowed: true },
  ];
  it.each(canonicalCases)('keeps canonical precedence for $name after preparation', async ({ input, allowed, registered, metadata }) => {
    const deps = dependencies();
    if (registered) deps.resolveContextGraphIdsByNameHashes.mockResolvedValue(new Map([[commitment('a'), 7n]]));
    if (metadata) deps.findContextGraphIdsWithReadAuthorityFacts.mockResolvedValue(new Set(['a']));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    // Populate live authority only after preparation; no prepared boolean or
    // query-local list may override the canonical decision's current inputs.
    deps.inputs.set('a', input);
    const ordinary = await resolveContextGraphReadAuthorityDecision(deps.createReadAuthorityInput('a', signal));
    expect(ordinary.outcome === 'allowed').toBe(allowed);
    expect(await check('a', signal)).toBe(allowed);
  });

  it('checks metadata absence at its canonical use after the registration await', async () => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    const pending = check('a', signal);
    deps.readMetadataRevision.mockReturnValue(1);
    expect(await pending).toBe(false);
    expect(deps.isPrivateLocalGraph).toHaveBeenCalledWith('a');
  });

  it.each(['missing', 'extra', 'wrong-key', 'zero', 'overflow'])('rejects %s registration maps without granting an owner', async (malformation) => {
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => {
      const result = new Map<string, bigint | null>(names.map((name) => [name, null]));
      if (malformation === 'missing' || malformation === 'wrong-key') result.delete(names[0]);
      if (malformation === 'extra' || malformation === 'wrong-key') result.set(commitment('other'), null);
      if (malformation === 'zero') result.set(names[0], 0n);
      if (malformation === 'overflow') result.set(names[0], 1n << 256n);
      return result;
    });
    await expect(prepareUnscopedContextGraphReadChecks(deps, ['a', 'b'], new AbortController().signal))
      .rejects.toThrow(/registration batch/);
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
  });

  it('accepts a complete structural ReadonlyMap implementation', async () => {
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => {
      const values = new Map(names.map((name) => [name, null] as const));
      return {
        get: values.get.bind(values),
        has: values.has.bind(values),
        forEach: values.forEach.bind(values),
        entries: values.entries.bind(values),
        keys: values.keys.bind(values),
        values: values.values.bind(values),
        get size() { return values.size; },
        [Symbol.iterator]: values[Symbol.iterator].bind(values),
      } satisfies ReadonlyMap<string, bigint | null>;
    });
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a', 'b'], signal);
    expect(await Promise.all(['a', 'b'].map((id) => check(id, signal)))).toEqual([true, true]);
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
  });

  it('rejects duplicate private entries that replace a registered result with absence and omit another owner', async () => {
    const deps = dependencies();
    deps.getRegisteredAuthority.mockImplementation(async (id) => id === 'private'
      ? { kind: 'private', onChainId: 7n, participantAgents: ['owner'] }
      : { kind: 'public', onChainId: 8n });
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async () => {
      const values = new Map<string, bigint | null>([[commitment('private'), 7n], [commitment('public'), null]]);
      return {
        get: values.get.bind(values), has: values.has.bind(values),
        forEach: values.forEach.bind(values), entries: values.entries.bind(values),
        keys: values.keys.bind(values), values: values.values.bind(values), size: 2,
        *[Symbol.iterator]() {
          yield [commitment('private'), 7n] as [string, bigint | null];
          yield [commitment('private'), null] as [string, bigint | null];
        },
      } satisfies ReadonlyMap<string, bigint | null>;
    });
    await expect(prepareUnscopedContextGraphReadChecks(deps, ['private', 'public'], new AbortController().signal))
      .rejects.toThrow(/registration batch/);
  });

  it.each(['short', 'tuple', 'extra', 'infinite'] as const)('rejects a %s iterator independently of its reported size', async (malformation) => {
    const deps = dependencies();
    let iterations = 0;
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => {
      const base = new Map(names.map((name) => [name, null]));
      return {
        size: names.length,
        *[Symbol.iterator]() {
          iterations += 1;
          yield malformation === 'tuple' ? [names[0]] : [names[0], null];
          if (malformation === 'short' || malformation === 'tuple') return;
          iterations += 1;
          yield [names[1], null];
          do {
            iterations += 1;
            yield [names[0], null];
          } while (malformation === 'infinite');
        },
        get: base.get.bind(base), has: base.has.bind(base), forEach: base.forEach.bind(base),
        entries: base.entries.bind(base), keys: base.keys.bind(base), values: base.values.bind(base),
      } as ReadonlyMap<string, bigint | null>;
    });
    await expect(prepareUnscopedContextGraphReadChecks(deps, ['a', 'b'], new AbortController().signal))
      .rejects.toThrow(/registration batch/);
    expect(iterations).toBeLessThanOrEqual(3);
    expect(deps.createReadAuthorityInput).not.toHaveBeenCalled();
  });

  it('owns the validated absence snapshot after an adapter mutates its returned map', async () => {
    const deps = dependencies();
    const result = new Map<string, bigint | null>([[commitment('a'), 7n]]);
    deps.resolveContextGraphIdsByNameHashes.mockResolvedValue(result);
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    result.set(commitment('a'), null);
    expect(await check('a', signal)).toBe(false);
    expect(deps.getRegisteredAuthority).toHaveBeenCalledWith('a');
  });

  it('binds bulk transport work to the request signal and rejects late completion after abort', async () => {
    const deps = dependencies();
    const stop = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names, options) => {
      expect(options.signal?.aborted).toBe(false);
      await new Promise<void>((resolve) => { release = resolve; started(); });
      return new Map(names.map((name) => [name, null]));
    });
    const pending = prepareUnscopedContextGraphReadChecks(deps, ['a'], stop.signal);
    await begun;
    const outcome = expect(pending).rejects.toThrow('cancelled');
    stop.abort(new Error('cancelled'));
    release();
    await outcome;
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
  });

  it('denies unavailable registration promptly and aborts hanging metadata work', async () => {
    const deps = dependencies();
    let metadataSignal!: AbortSignal;
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation(async (_ids, signal) => {
      metadataSignal = signal;
      return new Promise<ReadonlySet<string>>(() => {});
    });
    deps.resolveContextGraphIdsByNameHashes.mockRejectedValue(new Error('RPC unavailable'));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    expect(metadataSignal.aborted).toBe(true);
    expect(await check('a', signal)).toBe(false);
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
  });

  it('models an unavailable bulk provider as an explicit prepared result', async () => {
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockRejectedValue(new Error('RPC unavailable'));
    const signal = new AbortController().signal;
    const plan = await deps.prepareRegistrationReadPlan(['a'], signal);

    const preparation = await plan!.prepare(signal);

    expect(preparation.kind).toBe('unavailable');
    await expect(preparation.prepared.resolve(
      'a',
      async () => ({ kind: 'unregistered' }),
      signal,
    )).resolves.toEqual({
      authority: { kind: 'unavailable', reason: 'chain-name-binding-unavailable' },
      metadataAbsenceEligible: false,
    });
  });

  it('cancels four active metadata batches and never starts queued batches after registration failure', async () => {
    const deps = dependencies();
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const activeSignals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    let batchesStarted!: () => void;
    const firstFourStarted = new Promise<void>((resolve) => { batchesStarted = resolve; });
    const query = vi.spyOn(store, 'query').mockImplementation(async (_sparql, options) => {
      activeSignals.push(options!.signal!);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 4) batchesStarted();
      });
      return { type: 'bindings', bindings: [] };
    });
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation((ids, signal) => (
      projection.findContextGraphIdsWithReadAuthorityFacts(ids, { signal })
    ));
    let rejectRegistration!: (reason: Error) => void;
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRegistration = reject;
    }));
    const signal = new AbortController().signal;
    const pending = prepareUnscopedContextGraphReadChecks(
      deps, Array.from({ length: 800 }, (_, i) => `candidate-${i}`), signal,
    );
    await firstFourStarted;
    rejectRegistration(new Error('RPC unavailable'));
    const check = await pending;
    expect(activeSignals.every((activeSignal) => activeSignal.aborted)).toBe(true);
    expect(await check('candidate-799', signal)).toBe(false);
    for (const release of releases) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(query).toHaveBeenCalledTimes(4);
    expect(deps.getRegisteredAuthority).not.toHaveBeenCalled();
    await store.close();
  });

  it('yields large commitment preparation so caller cancellation stops before the batch read', async () => {
    const deps = dependencies();
    const stop = new AbortController();
    setImmediate(() => stop.abort(new Error('cancelled while preparing')));
    await expect(prepareUnscopedContextGraphReadChecks(
      deps, Array.from({ length: 2048 }, (_, i) => `candidate-${i}`), stop.signal,
    )).rejects.toThrow('cancelled while preparing');
    expect(deps.resolveContextGraphIdsByNameHashes).not.toHaveBeenCalled();
    expect(deps.registrationNameHash.mock.calls.length).toBeLessThan(2048);
  });
});

describe('batched local read-authority facts', () => {
  it.each(['meta', 'agents', 'ontology', 'catalog'].flatMap((source) => (
    ['insert', 'replaceSubject'].map((operation) => [source, operation])
  )))('invalidates prepared absence after restricted access rights in %s via %s', async (source, operation) => {
    const rawStore = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(rawStore);
    const store = createListContextGraphsCacheInvalidatingStore(rawStore, () => {}, (quads, targetGraph) => {
      if (targetGraph) projection.markDirtyForGraph(targetGraph);
      else if (quads) projection.markDirtyFromQuads(quads);
      else projection.markAllDirty();
    });
    const id = 'candidate';
    const deps = dependencies();
    deps.readMetadataRevision.mockImplementation(() => projection.readAuthorityFactsRevision);
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation((ids, signal) => (
      projection.findContextGraphIdsWithReadAuthorityFacts(ids, { signal })
    ));
    deps.isPrivateLocalGraph.mockImplementation(async (candidate) => (
      (await projection.get(candidate)).accessPolicy === 'private'
    ));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, [id], signal);
    expect(await check(id, signal)).toBe(true);
    const graphs: Record<string, string> = {
      meta: contextGraphMetaUri(id), catalog: contextGraphCatalogUri(id),
      agents: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      ontology: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    };
    const quads = [{ subject: contextGraphDataUri(id), graph: graphs[source],
      predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED }];
    if (operation === 'insert') await store.insert(quads);
    else await store.replaceSubject!(graphs[source], contextGraphDataUri(id), quads);
    expect((await projection.get(id)).accessPolicy).toBe('private');
    expect(await check(id, signal)).toBe(false);
    expect(deps.isPrivateLocalGraph).toHaveBeenCalledWith(id);
    await store.close();
  });

  it('covers exact owner facts in every projection source, including gate-only metadata', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ids = ['tenant/meta', 'tenant/agents', 'tenant/catalog', 'tenant/ontology', 'ordinary'];
    const sources = [contextGraphMetaUri(ids[0]), contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      contextGraphCatalogUri(ids[2]), contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)];
    await store.insert(ids.slice(0, 4).map((id, index) => ({
      subject: contextGraphDataUri(id), graph: sources[index],
      predicate: index === 0 ? DKG_ONTOLOGY.DKG_ALLOWED_AGENT : DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: index === 0 ? 'did:dkg:agent:outsider' : '"private"',
    })));
    await store.insert([{ subject: 'urn:unrelated', predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"', graph: contextGraphMetaUri('ordinary') }]);
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts(ids)).toEqual(new Set(ids.slice(0, 4)));
    await store.close();
  });

  it('queries bounded batches and finds metadata after the old 512-candidate boundary', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ids = Array.from({ length: 600 }, (_, i) => `public/partition/${i}`);
    await store.insert([{ subject: contextGraphDataUri(ids[599]), predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: '"peer-private"', graph: contextGraphMetaUri(ids[599]) }]);
    const query = vi.spyOn(store, 'query');
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts(ids)).toEqual(new Set([ids[599]]));
    expect(query).toHaveBeenCalledTimes(5);
    for (const [sparql] of query.mock.calls) expect((sparql.match(/\(<did:dkg:context-graph:/g) ?? []).length).toBeLessThanOrEqual(128);
    await store.close();
  });

  it('retains cached restrictive authority even if its original store facts have disappeared', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'cached-private';
    await store.insert([{ subject: contextGraphDataUri(id), predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"', graph: contextGraphMetaUri(id) }]);
    await projection.get(id);
    await store.dropGraph(contextGraphMetaUri(id));
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts([id])).toEqual(new Set([id]));
    const before = projection.readAuthorityFactsRevision;
    projection.markDirty(id);
    expect(projection.readAuthorityFactsRevision).not.toBe(before);
    await store.close();
  });

  it('rejects malformed local discovery instead of treating it as absence', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'boolean', value: false });
    await expect(projection.findContextGraphIdsWithReadAuthorityFacts(['a'])).rejects.toThrow(/invalid local read-authority/);
    await store.close();
  });
});
