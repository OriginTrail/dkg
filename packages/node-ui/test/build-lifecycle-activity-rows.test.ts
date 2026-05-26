import { describe, expect, it } from 'vitest';
import { buildLifecycleActivityRows } from '../src/ui/hooks/useProjectActivity.js';
import type { AssertionLifecycleEvent } from '../src/ui/hooks/useAssertionLifecycleEvents.js';

// N6 polish (task #23) — `buildLifecycleActivityRows` converts
// agent-DID-keyed lifecycle events into rows the activity feed
// renders. One row per event, agent attribution on `authorUri`,
// per-bundle root count on `entityCount` (promoted only).
describe('buildLifecycleActivityRows', () => {
  const baseCreated: AssertionLifecycleEvent = {
    eventUri: 'urn:evt:create-1',
    kind: 'created',
    assertionUri: 'urn:assert:doc-1',
    assertionName: 'doc-1',
    agentUri: 'did:dkg:agent:alice',
    publishedAt: '2026-05-20T10:00:00Z',
  };
  const basePromoted: AssertionLifecycleEvent = {
    eventUri: 'urn:evt:promote-1',
    kind: 'promoted',
    assertionUri: 'urn:assert:doc-1',
    assertionName: 'doc-1',
    agentUri: 'did:dkg:agent:bob',
    publishedAt: '2026-05-22T10:00:00Z',
    entityCount: 5,
  };

  it('emits one row per event (no per-rootEntity unwind)', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    expect(items).toHaveLength(2);
  });

  it('maps created→`added` and promoted→`promoted`, with the right trust layer', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    const created = items.find(i => i.entity.uri === 'urn:assert:doc-1' && i.event === 'added');
    const promoted = items.find(i => i.entity.uri === 'urn:assert:doc-1' && i.event === 'promoted');
    expect(created?.layer).toBe('working');
    expect(promoted?.layer).toBe('shared');
  });

  it('carries the agent DID on `authorUri` (no peer-id leak)', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    expect(items.find(i => i.event === 'added')?.authorUri).toBe('did:dkg:agent:alice');
    expect(items.find(i => i.event === 'promoted')?.authorUri).toBe('did:dkg:agent:bob');
  });

  it('surfaces entityCount only on promoted rows (created rows omit it)', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    const created = items.find(i => i.event === 'added');
    const promoted = items.find(i => i.event === 'promoted');
    expect(created?.entityCount).toBeUndefined();
    expect(promoted?.entityCount).toBe(5);
  });

  it('uses the assertion name as the entity label, with URI-tail fallback', () => {
    const items = buildLifecycleActivityRows([
      baseCreated,
      { ...basePromoted, assertionName: '' },
    ]);
    expect(items.find(i => i.event === 'added')?.entity.label).toBe('doc-1');
    // Fallback path strips the URN prefix and shows the tail.
    expect(items.find(i => i.event === 'promoted')?.entity.label).toBe('doc-1');
  });

  it('renders rows non-clickable (pre-S4: no assertion-detail surface)', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    expect(items.every(i => i.clickable === false)).toBe(true);
  });

  it('produces stable per-event ids (one bundle promote = one id)', () => {
    const items = buildLifecycleActivityRows([
      basePromoted,
      // Same agent re-promoting the same assertion gets a fresh event URI
      // → distinct row + distinct id.
      { ...basePromoted, eventUri: 'urn:evt:promote-2', publishedAt: '2026-05-23T10:00:00Z' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
  });

  it('sorts newest-first', () => {
    const items = buildLifecycleActivityRows([baseCreated, basePromoted]);
    expect(items[0].event).toBe('promoted'); // 05-22 > 05-20
    expect(items[1].event).toBe('added');
  });

  it('filters by agentUri when supplied', () => {
    const items = buildLifecycleActivityRows(
      [baseCreated, basePromoted],
      { agentUri: 'did:dkg:agent:bob' },
    );
    expect(items.map(i => i.authorUri)).toEqual(['did:dkg:agent:bob']);
  });

  it('drops rows with unparseable timestamps', () => {
    const items = buildLifecycleActivityRows([
      { ...baseCreated, publishedAt: 'not-a-date' },
    ]);
    expect(items).toHaveLength(0);
  });
});
