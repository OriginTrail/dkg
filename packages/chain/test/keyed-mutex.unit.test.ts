import { describe, it, expect } from 'vitest';
import { KeyedSerializer } from '../src/keyed-mutex.js';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('KeyedSerializer', () => {
  it('serializes same-key operations in submission order with no overlap', async () => {
    const s = new KeyedSerializer();
    const events: string[] = [];
    const op = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(10);
      events.push(`end:${id}`);
      return id;
    };

    const results = await Promise.all([
      s.run('w', op('a')),
      s.run('w', op('b')),
      s.run('w', op('c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    // Strict mutual exclusion: every start immediately follows the prior end.
    expect(events).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('runs different keys concurrently', async () => {
    const s = new KeyedSerializer();
    const events: string[] = [];
    const op = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
    };

    await Promise.all([s.run('w1', op('a')), s.run('w2', op('b'))]);

    // Both started before either ended → they overlapped.
    expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  it('does not wedge a key queue when an operation rejects', async () => {
    const s = new KeyedSerializer();
    await expect(
      s.run('w', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The next op on the same key must still run.
    await expect(s.run('w', async () => 'ok')).resolves.toBe('ok');
  });

  it('releases keys once their queue drains (bounded map)', async () => {
    const s = new KeyedSerializer();
    await s.run('w', async () => undefined);
    // Allow the cleanup microtask to run.
    await tick(0);
    expect(s.activeKeyCount).toBe(0);
  });

  it('prevents the publisher nonce race: same-wallet sends get distinct, monotonic nonces', async () => {
    // Model the real bug (OriginTrail/dkg#953): an op-wallet's `pending`
    // nonce only advances AFTER a tx is broadcast, and there's an async gap
    // between reading the nonce (populate/sign) and broadcasting. Two
    // concurrent sends routed to the SAME wallet that both read before either
    // broadcasts pick the same nonce → the second reverts "Nonce too low".
    const makeWallet = () => {
      let pending = 0; // on-chain pending tx count for this wallet
      return {
        getNonce: async () => {
          await tick(5);
          return pending;
        },
        broadcast: async (n: number) => {
          await tick(5);
          if (n !== pending) {
            throw new Error(`Nonce too low: expected ${pending} but got ${n}`);
          }
          pending += 1;
          return n;
        },
      };
    };
    const send = (w: ReturnType<typeof makeWallet>) => async () => {
      const nonce = await w.getNonce(); // read pending
      await tick(5); // populate / sign gap
      return w.broadcast(nonce); // broadcast — must equal current pending
    };

    // CONTROL — unserialized concurrent sends on one wallet collide. This
    // documents that the race is real and that the test exercises it.
    const buggyWallet = makeWallet();
    const buggy = await Promise.allSettled([
      send(buggyWallet)(),
      send(buggyWallet)(),
      send(buggyWallet)(),
    ]);
    expect(buggy.some((r) => r.status === 'rejected')).toBe(true);

    // FIX — serialized per wallet: monotonic nonces, zero collisions.
    const s = new KeyedSerializer();
    const fixedWallet = makeWallet();
    const fixed = await Promise.all([
      s.run('wallet-1', send(fixedWallet)),
      s.run('wallet-1', send(fixedWallet)),
      s.run('wallet-1', send(fixedWallet)),
    ]);
    expect(fixed).toEqual([0, 1, 2]);
  });
});
