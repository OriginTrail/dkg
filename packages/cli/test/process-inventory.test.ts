import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { inspectPsProcessSync, parseProcessInventory, processDescendants, processStateIsGone,
  readProcessInventorySync, readProcessState } from '../src/daemon/process-probe.js';
const start = 'Wed Oct 28 07:00:00 2026';

describe('complete process inventory observations', () => {
  it('joins ownership hints without replacing the observed identity or parent', () => {
    const inventory = parseProcessInventory('12 node worker DKG_HOME=/node4\n13 helper\n14 oxigraph serve',
      '12 999 /Program Files/node\n13 777 /bin/helper\n14 1 /usr/bin/oxigraph',
      `12 1 S ${start} node worker\n13 12 S ${start} helper\n14 1 S ${start} oxigraph serve`);
    expect(inventory.records.get(12)).toEqual({ pid: 12, ppid: 1, start, argv: null, command: 'node worker',
      executable: 'node', ownershipText: 'node worker DKG_HOME=/node4' });
    expect(inventory.childrenByParent.get(12)).toEqual([13]);
    expect([...processDescendants([12], inventory.childrenByParent)]).toEqual([13]);
  });
  it('drops inconsistent, incomplete, exited and malformed snapshot rows', () => {
    const inventory = parseProcessInventory('1 old node DKG_HOME=/owned\n2 node workerX DKG_HOME=/owned\n3 node\n4 node\n5 node\n6 node',
      '1 0 node\n2 0 node\n3 0 node\n4 0 node\n5 0 node\n7 0 node',
      `bad\n0 0 S ${start} node\n1 0 S ${start} replacement\n2 0 S ${start} node worker\n3 0 Z ${start} node\n4 0 SE ${start} node\n5 invalid\n6 0 S ${start} node\n7 0 S ${start} node`);
    expect([...inventory.records]).toEqual([]);
  });
  it('walks a fixed snapshot once even with repeated roots and a parent cycle', () => {
    expect([...processDescendants([1, 1], new Map([[1, [2, 3]], [2, [4]], [3, [4]], [4, [1, 2]]]))]).toEqual([2, 3, 4]);
    expect([...processDescendants([9], new Map())]).toEqual([]);
    expect(processStateIsGone('Z+')).toBe(true); expect(processStateIsGone('SE')).toBe(true);
    expect(processStateIsGone('S')).toBe(false); expect(processStateIsGone(null)).toBe(false);
  });
  it('reads a live native identity consistently across the synchronous inventory and inspector', () => {
    const observed = inspectPsProcessSync(process.pid);
    expect(observed.state).toBe('running');
    if (observed.state !== 'running') throw new Error('Test runner must be observable');
    const inventory = readProcessInventorySync();
    expect(inventory.records.get(process.pid)).toMatchObject(observed.process);
    expect(readProcessState(process.pid)).toMatch(/\S/);
    const exited = spawnSync(process.execPath, ['-e', '0']);
    expect(inspectPsProcessSync(exited.pid)).toEqual({ state: 'gone' });
    expect(readProcessState(exited.pid)).toBeNull();
  });
});
