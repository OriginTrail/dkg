import { expect, it } from 'vitest';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';

it('fences old continuations across close and reopen without losing physical work', async () => {
  const owner = new AgentWorkLifetime();
  const oldSignal = owner.signal, generation = owner.generation;
  let release!: () => void;
  const pending = owner.track(new Promise<void>(resolve => { release = resolve; }));
  const reason = new Error('stopping');
  owner.close(reason); owner.close();
  expect(oldSignal.reason).toBe(reason);
  expect(owner.generation).toBe(generation + 1);
  expect(owner.physicalRuns.has(pending)).toBe(true);
  let drained = false;
  const drain = owner.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  owner.open();
  expect(owner.signal.aborted).toBe(false);
  expect(oldSignal.aborted).toBe(true);
  expect(owner.generation).not.toBe(generation);
  release(); await drain;
  expect(owner.physicalRuns.size).toBe(0);
});

it('drains newly tracked retirement work and consumes physical rejections', async () => {
  const owner = new AgentWorkLifetime();
  let release!: () => void, retire!: () => void;
  owner.track(new Promise<void>(resolve => { release = resolve; }).then(() => {
    owner.track(new Promise<void>(resolve => { retire = resolve; }));
    throw new Error('physical dependency failed');
  }));
  owner.close();
  let drained = false;
  const drain = owner.drain().then(() => { drained = true; });
  release(); await new Promise(resolve => setImmediate(resolve));
  expect(drained).toBe(false);
  expect(owner.physicalRuns.size).toBe(1);
  retire(); await drain;
  expect(owner.physicalRuns.size).toBe(0);
});

it('waits for materialization work enqueued while a dependency retires', async () => {
  const owner = new AgentWorkLifetime();
  let release!: () => void, commit!: () => void;
  owner.track(new Promise<void>(resolve => { release = resolve; }).then(() => {
    owner.track(new Promise<void>(resolve => { commit = resolve; }));
  }));
  owner.close();
  let drained = false;
  const drain = owner.drain().then(() => { drained = true; });
  release(); await new Promise(resolve => setImmediate(resolve));
  expect(drained).toBe(false);
  expect(owner.physicalRuns.size).toBe(1);
  commit(); await drain;
  expect(owner.physicalRuns.size).toBe(0);
});
