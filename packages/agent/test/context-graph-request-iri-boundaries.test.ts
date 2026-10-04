import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import { OwnershipMethods } from '../src/dkg-agent-ownership.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

describe('context graph sibling request reads', () => {
  it.each(['victim> } UNION { GRAPH ?g { ?s ?p ?o } } #', 'bad\\id', 'bad\nname'])('rejects %j before policy, registration or preflight store reads', async id => {
    const query = vi.fn();
    const load = vi.fn();
    const receiver = { store: { query }, config: { contextGraphSubscriptionStore: { load } } } as unknown as DKGAgent;
    await expect(OwnershipMethods.prototype.listCclPolicyBindings.call(receiver, { contextGraphId: id })).rejects.toThrow();
    await expect(ContextGraphRegistryMethods.prototype.getStoredContextGraphRegistrationOptions.call(receiver, id)).rejects.toThrow();
    await expect(ContextGraphResolveMethods.prototype.probeContextGraphWritePreflight.call(receiver, id)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
