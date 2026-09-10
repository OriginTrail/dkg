import { expect, it } from 'vitest';
import { RetryQueue } from '../src/retry-queue.js';

it('a repeated outage retains one entry per destination and expires from the first failure', () => {
  const queue = new RetryQueue<{ destination: number }>({ backoffs: [10, 100, 1000], maxAgeMs: 20_000 });
  const destinations = 64;
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const destination = attempt % destinations;
    const entry = queue.enqueueFailure(String(destination), { destination }, 'transport unavailable', attempt);
    expect(entry.nextAttemptAt - attempt).toBeLessThanOrEqual(1000);
  }
  expect(queue.size()).toBe(destinations);
  expect(queue.due(12_000)).toHaveLength(destinations);
  expect(queue.dropExpired(20_064)).toHaveLength(destinations);
  expect(queue.size()).toBe(0);
  expect(queue.due(30_000)).toEqual([]);
});
