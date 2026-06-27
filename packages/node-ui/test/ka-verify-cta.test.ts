// @vitest-environment happy-dom
//
// Component regression test for the entity-level "Verify on DKG" CTA
// (VerifyOnDkgButton in ka.tsx). #1087 changed the SWM→VM publish action from
// root-entity publishing to NAMED knowledge-asset publishing via the canonical
// per-KA /vm/publish, and added a disabled state for entities that are not part
// of a named SWM asset. These tests pin: (1) the publish CTA calls
// knowledgeAssetPublishWithSeal with the entity's owning `sourceAssertion` AND
// its `subGraphName` (so a future change can't drop the slug or publish the
// wrong assertion), and (2) a shared entity with no named source assertion
// disables the CTA rather than publishing the wrong thing.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  knowledgeAssetPublishWithSeal: vi.fn(),
  promoteAssertion: vi.fn(),
}));

vi.mock('../src/ui/api.js', () => ({
  promoteAssertion: apiMocks.promoteAssertion,
  knowledgeAssetPublishWithSeal: apiMocks.knowledgeAssetPublishWithSeal,
  describePromoteResult: (_n: string, r: unknown) => r,
  describePromoteError: () => null,
  partialPublishWarning: () => '',
  PARTIAL_PUBLISH_STATUS_SUFFIX: 'binding incomplete',
  SwmSubsetNotSealableError: class SwmSubsetNotSealableError extends Error {},
}));

// The profile context drives the CTA copy + the publish target.
const profileRef = vi.hoisted(() => ({ current: null as any }));
vi.mock('../src/ui/hooks/useProjectProfile.js', () => ({
  useProjectProfileContext: () => profileRef.current,
}));

// Stub the hooks/components the module pulls in but the button path doesn't drive.
vi.mock('../src/ui/api-wrapper.js', () => ({ api: {} }));
vi.mock('../src/ui/hooks/useMemoryEntities.js', () => ({
  useMemoryEntities: () => ({ entities: [], loading: false }),
  canonicalEntityUri: (e: any) => e?.uri ?? '',
  isFirstClassEntity: () => true,
}));
vi.mock('../src/ui/hooks/useAgents.js', () => ({ useAgentsContext: () => ({ agents: [] }) }));
vi.mock('../src/ui/genui/index.js', () => ({ GenUIEntityPanel: () => null }));
vi.mock('../src/ui/views/project/components/graph.js', () => ({ GraphSurface: () => null, RdfGraph: () => null }));
vi.mock('../src/ui/components/AgentChip.js', () => ({ AgentChip: () => null }));
vi.mock('../src/ui/components/VerifiedIdentityBanner.js', () => ({ VerifiedIdentityBanner: () => null }));

const { VerifyOnDkgButton } = await import('../src/ui/views/project/components/ka.js');

async function render(node: React.ReactElement): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// A 'shared'-layer entity that lives in sub-graph 'sg1'.
const sharedEntity = { trustLevel: 'shared', types: ['ex:Character'], subGraphs: ['sg1'], uri: 'urn:e:hero' } as any;

beforeEach(() => {
  apiMocks.knowledgeAssetPublishWithSeal.mockReset();
  apiMocks.knowledgeAssetPublishWithSeal.mockResolvedValue({ status: 'confirmed', txHash: '0xtx', kaId: '1' });
  apiMocks.promoteAssertion.mockReset();
  profileRef.current = null;
});
afterEach(() => { document.body.innerHTML = ''; });

describe('VerifyOnDkgButton — entity-level SWM→VM publish CTA (#1087 named-KA)', () => {
  it("publishes the entity's owning NAMED assertion via knowledgeAssetPublishWithSeal, threading its subGraphName", async () => {
    profileRef.current = {
      forType: () => ({ publishLabel: 'Publish as canon', publishHint: 'Anchors on-chain.' }),
      forSubGraph: (s: string) => (s === 'sg1' ? { sourceAssertion: 'character-sheet' } : null),
    };
    const onVerified = vi.fn();
    const { container, unmount } = await render(
      React.createElement(VerifyOnDkgButton, { entity: sharedEntity, contextGraphId: 'cg-1', onVerified }),
    );
    await flush();

    const btn = container.querySelector('button.v10-ka-verify-btn') as HTMLButtonElement;
    expect(btn, 'publish CTA renders for a named shared entity').toBeTruthy();
    expect(btn.disabled).toBe(false);

    await act(async () => { btn.click(); });
    await flush();

    // The named-KA publish contract: publish the OWNING sourceAssertion, not the
    // raw entity URI, and thread the sub-graph slug so the daemon keys (cg,name,subGraph).
    expect(apiMocks.knowledgeAssetPublishWithSeal).toHaveBeenCalledTimes(1);
    expect(apiMocks.knowledgeAssetPublishWithSeal).toHaveBeenCalledWith('cg-1', 'character-sheet', { subGraphName: 'sg1' });
    await unmount();
  });

  it('disables the CTA for a shared entity with no named sourceAssertion (not publishable from here)', async () => {
    profileRef.current = {
      forType: () => ({ publishLabel: 'Publish as canon', publishHint: 'Anchors on-chain.' }),
      forSubGraph: () => ({}), // binding exists but declares no sourceAssertion
    };
    const { container, unmount } = await render(
      React.createElement(VerifyOnDkgButton, { entity: sharedEntity, contextGraphId: 'cg-1', onVerified: vi.fn() }),
    );
    await flush();

    const btn = container.querySelector('button.v10-ka-verify-btn') as HTMLButtonElement;
    expect(btn?.disabled, 'CTA disabled without a named source assertion').toBe(true);
    expect(container.textContent).toContain('not part of a named Shared-Memory asset');
    expect(apiMocks.knowledgeAssetPublishWithSeal).not.toHaveBeenCalled();
    await unmount();
  });
});
