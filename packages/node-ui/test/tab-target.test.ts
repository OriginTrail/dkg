// The one tab model (lib/tab-target.ts): every tab-id shape decodes to one
// target, and routing derives its paths from it.
import { describe, expect, it } from 'vitest';
import { NODE_PLACE_IDS, PLACES, PLACE_IDS, decodeTabId, isPlaceId, tabContextGraphId } from '../src/ui/lib/tab-target.js';
import { encodeDocTabId } from '../src/ui/lib/doc-tab-id.js';
import { pathToTab, tabIdToPath } from '../src/ui/lib/tab-routes.js';

describe('decodeTabId', () => {
  it('decodes every tab-id shape', () => {
    expect(decodeTabId('settings')).toEqual({ kind: 'place', id: 'settings' });
    expect(decodeTabId('project:cg-1')).toEqual({ kind: 'graph', contextGraphId: 'cg-1' });
    expect(decodeTabId('conviction:7')).toEqual({ kind: 'conviction', accountId: '7' });
    expect(decodeTabId('agent:cg-1|hermes')).toEqual({ kind: 'agent', contextGraphId: 'cg-1', slug: 'hermes', agentUri: 'urn:dkg:agent:hermes' });
    expect(decodeTabId('agent:cg-1|did:dkg:agent:0xabc')).toMatchObject({ kind: 'agent', agentUri: 'did:dkg:agent:0xabc' });
    expect(decodeTabId('wm:cg-1')).toEqual({ kind: 'layer', layer: 'wm', contextGraphId: 'cg-1' });
    expect(decodeTabId('vm:cg-2')).toEqual({ kind: 'layer', layer: 'vm', contextGraphId: 'cg-2' });
    const doc = encodeDocTabId('cg-1', 'urn:dkg:file:keccak256:abc', 'text/markdown');
    expect(decodeTabId(doc)).toMatchObject({ kind: 'document', docRef: 'urn:dkg:file:keccak256:abc', contentType: 'text/markdown' });
  });

  it('never throws: malformed or unknown ids are "other"', () => {
    for (const id of ['agent:', 'agent:cg-1|', 'agent:|slug', 'nonsense', '']) expect(decodeTabId(id), id).toEqual({ kind: 'other', id });
  });

  it('names the context graph a tab belongs to', () => {
    expect(tabContextGraphId('project:cg-1')).toBe('cg-1');
    expect(tabContextGraphId('agent:cg-2|hermes')).toBe('cg-2');
    expect(tabContextGraphId('swm:cg-3')).toBe('cg-3');
    expect(tabContextGraphId(encodeDocTabId('cg-4', 'urn:dkg:file:keccak256:abc', ''))).toBe('cg-4');
    expect(tabContextGraphId('settings')).toBeNull();
    expect(tabContextGraphId('conviction:7')).toBeNull();
  });
});

describe('places', () => {
  it('lists every place once, with the Node group a subset in display order', () => {
    expect(new Set(PLACE_IDS).size).toBe(PLACE_IDS.length);
    for (const id of PLACE_IDS) expect(isPlaceId(id)).toBe(true);
    expect(isPlaceId('project:x')).toBe(false);
    expect(NODE_PLACE_IDS).toEqual(['operations', 'conviction', 'settings']);
    for (const id of NODE_PLACE_IDS) expect(PLACES[id].node).toBe(true);
  });

  it('routes every place to its own path and back', () => {
    for (const id of PLACE_IDS) {
      expect(tabIdToPath(id)).toBe(PLACES[id].path);
      expect(pathToTab(PLACES[id].path)?.id).toBe(id);
    }
  });

  it('routes typed tabs, and sends anything without a readable path through /open', () => {
    expect(tabIdToPath('agent:cg-1|hermes')).toBe('/agent/cg-1/hermes');
    expect(tabIdToPath('conviction:abc')).toBe('/open/conviction:abc');
    expect(tabIdToPath('wm:cg-1')).toBe('/open/wm:cg-1');
    expect(pathToTab('/open/wm:cg-1')?.id).toBe('wm:cg-1');
  });
});
