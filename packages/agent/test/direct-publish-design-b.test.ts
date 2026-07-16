import { afterEach, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

describe('direct agent.publish Design B payloads', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('accepts multi-root payloads and preserves per-root manifest token IDs', async () => {
    agent = await DKGAgent.create({
      name: 'DirectPublishDesignB',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'core',
      skills: [],
    });
    await agent.start();

    const roots = ['urn:test:direct-design-b:one', 'urn:test:direct-design-b:two'];
    const result = await agent.publish(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, [
      { subject: roots[0], predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: roots[1], predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ]);

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(new Set(result.kaManifest.map((m) => m.rootEntity))).toEqual(new Set(roots));
    expect(new Set(result.kaManifest.map((m) => String(m.tokenId)))).toEqual(new Set(['1', '2']));
  });
});
