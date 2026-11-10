// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway's turns: one call at a time per budget, in order; a bounded
 * queue per budget and a bound over the whole gateway, both refused at once;
 * a waiting call that leaves when its client goes away, its turn never taken;
 * and a failed call that passes the turn on.
 */
import { describe, expect, it } from 'vitest';
import { CallerGone, Turns, TurnsFull } from '../src/gateway-turns.js';

/** A call that runs until `release()`: `running` resolves once it has started. */
function gated() {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const done = new Promise<void>((resolve) => { release = resolve; });
  return { fn: async () => { started(); await done; return 'done'; }, running, release };
}

describe('the gateway turns', () => {
  it('run calls on one budget one at a time and in order, and calls on two budgets at once', async () => {
    const turns = new Turns({ waitingPerKey: 4, calls: 16 });
    const order: string[] = [];
    const [a, b, other] = [gated(), gated(), gated()];
    const first = turns.run('budget', async () => { order.push('a'); return a.fn(); });
    const second = turns.run('budget', async () => { order.push('b'); return b.fn(); });
    const elsewhere = turns.run('other budget', async () => { order.push('other'); return other.fn(); });
    await Promise.all([a.running, other.running]);
    expect(order).toEqual(['a', 'other']);
    expect(turns.size).toBe(3);
    a.release();
    await b.running;
    expect(order).toEqual(['a', 'other', 'b']);
    b.release();
    other.release();
    await expect(Promise.all([first, second, elsewhere])).resolves.toEqual(['done', 'done', 'done']);
    expect(turns.size).toBe(0);
  });

  it('refuse a call at once when its budget has as many waiting as it takes, or the gateway as many calls', async () => {
    const turns = new Turns({ waitingPerKey: 2, calls: 4 });
    const gate = gated();
    // One running and two waiting: the budget's queue is full.
    const calls = [turns.run('budget', gate.fn), turns.run('budget', gate.fn), turns.run('budget', gate.fn)];
    const full = turns.run('budget', gate.fn);
    await expect(full).rejects.toBeInstanceOf(TurnsFull);
    await expect(full).rejects.toMatchObject({ scope: 'budget' });
    // A fourth call on another budget fills the gateway.
    calls.push(turns.run('other budget', gate.fn));
    await expect(turns.run('third budget', gate.fn)).rejects.toMatchObject({ scope: 'gateway' });
    expect(turns.size).toBe(4);
    gate.release();
    await Promise.all(calls);
    expect(turns.size).toBe(0);
    await expect(turns.run('budget', async () => 'room again')).resolves.toBe('room again');
  });

  it('let a waiting call leave when its client goes away, so its turn is never taken', async () => {
    const turns = new Turns({ waitingPerKey: 4, calls: 16 });
    const gate = gated();
    const first = turns.run('budget', gate.fn);
    const client = new AbortController();
    let ran = false;
    const leaving = turns.run('budget', async () => { ran = true; return 'ran'; }, client.signal);
    const third = turns.run('budget', async () => 'third');
    expect(turns.size).toBe(3);
    client.abort();
    await expect(leaving).rejects.toBeInstanceOf(CallerGone);
    expect(turns.size).toBe(2);
    gate.release();
    await expect(third).resolves.toBe('third');
    await first;
    expect(ran).toBe(false);
    // A client gone before the call is taken: refused at once, and nothing waits.
    await expect(turns.run('budget', async () => 'never', AbortSignal.abort())).rejects.toBeInstanceOf(CallerGone);
    expect(turns.size).toBe(0);
  });

  it('pass the turn on when a call fails', async () => {
    const turns = new Turns();
    const failing = turns.run('budget', async () => { throw new Error('the seller went away'); });
    const next = turns.run('budget', async () => 'next');
    await expect(failing).rejects.toThrow('the seller went away');
    await expect(next).resolves.toBe('next');
    expect(turns.size).toBe(0);
  });
});
