import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayConnectionRuntimeV1 } from
  '../src/rfc64/catalog-replay-connection-runtime-v1.js';

describe('RFC-64 catalog replay connection debounce', () => {
  it('evicts only the oldest peer when the debounce table reaches capacity', () => {
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['public-cg'],
      acquireFence: () => ({ release: vi.fn() }),
      reannounce: vi.fn(async () => undefined),
      replay: vi.fn(async () => ({ failed: 0 })),
      warn: vi.fn(),
    }, 100, 2);

    runtime.prepare('peer-a', 0)?.admit();
    runtime.prepare('peer-b', 1)?.admit();
    runtime.prepare('peer-c', 2)?.admit();

    expect(runtime.prepare('peer-b', 3)).toBeNull();
    const retriedA = runtime.prepare('peer-a', 3);
    expect(retriedA).not.toBeNull();
    retriedA?.reject();
  });
});
