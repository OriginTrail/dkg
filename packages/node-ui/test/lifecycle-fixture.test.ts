import { expect, it } from 'vitest';
import { requireSeededUserGraph } from '../e2e/helpers/lifecycle-fixture.js';

it('binds the lifecycle to its user graph regardless of API ordering or unrelated system graphs', () => {
  const user = { id: 'devnet-test', name: 'Devnet Test' };
  const system = { id: 'agents', name: 'Agent Registry', isSystem: true };
  for (const graphs of [[system, user], [user, system]]) {
    expect(requireSeededUserGraph(graphs, 'devnet-test')).toBe(user);
  }
});

it('refuses missing, duplicate, unfinished, or system-only fixtures instead of skipping the scenario', () => {
  for (const graphs of [[], [{ id: 'agents', name: 'Agent Registry', isSystem: true }],
    [{ id: 'devnet-test', name: '' }], [{ id: 'devnet-test', name: 'System', isSystem: true }],
    [{ id: 'devnet-test', name: 'First' }, { id: 'devnet-test', name: 'Second' }]]) {
    expect(() => requireSeededUserGraph(graphs, 'devnet-test')).toThrow('Required user context graph devnet-test is not ready');
  }
});
