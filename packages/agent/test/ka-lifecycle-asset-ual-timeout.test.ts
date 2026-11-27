import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('KA lifecycle asset UAL derivation logging', () => {
  it('does not block sender-key receive logging when the chain lookup stalls', async () => {
    const warnings: string[] = [];
    const fakeAgent = {
      chain: {
        chainId: 31337,
        getDKGKnowledgeAssetsAddress: () => new Promise<string>(() => {}),
      },
      log: {
        warn: (_ctx: unknown, message: string) => warnings.push(message),
      },
    };

    const resolveAssetUal = WorkspaceCryptoMethods.prototype.resolveKaLifecycleAssetUalFromIdentity as unknown as (
      this: typeof fakeAgent,
      agentAddress?: string,
      kaNumber?: string,
      ctx?: ReturnType<typeof createOperationContext>,
    ) => Promise<string | undefined>;

    const result = await withDeadline(
      resolveAssetUal.call(
        fakeAgent,
        '0x1111111111111111111111111111111111111111',
        '7',
        createOperationContext('share'),
      ),
      250,
    );

    expect(result).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.stringContaining('KA lifecycle assetUal derivation exceeded 50ms'),
    );
  });
});
