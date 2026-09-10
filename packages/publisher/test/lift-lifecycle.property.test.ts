import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

it('generated claim, validate, finalize and restart sequences preserve durable lifecycle state', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('claim', 'validate', 'finalize', 'restart'), { maxLength: 25 }), async (commands) => {
    const store = new OxigraphStore();
    try {
      let now = 1_000;
      const config = { now: () => ++now, idGenerator: () => 'generated-job', journalWrites: true };
      let publisher = new TripleStoreAsyncLiftPublisher(store, config);
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      let state = 'accepted';
      const request = (await publisher.getStatus(id))!.request;
      for (const command of commands) {
        if (command === 'restart') publisher = new TripleStoreAsyncLiftPublisher(store, config);
        else if (command === 'claim') {
          const claimed = await publisher.claimNext('wallet-1');
          expect(claimed?.jobId ?? null).toBe(state === 'accepted' ? id : null);
          if (state === 'accepted') state = 'claimed';
        } else {
          const next = command === 'validate' ? 'validated' : 'finalized';
          // Administrative updates allow an idempotent replay of the same state.
          const legal = state === next || (state === 'claimed' && next === 'validated') || (state === 'validated' && next === 'finalized');
          const operation = next === 'validated'
            ? publisher.update(id, 'validated', { validation: KA_VM_VALIDATION })
            : publisher.update(id, 'finalized', { finalization: { mode: 'local' } });
          if (legal) { await operation; state = next; }
          else await expect(operation).rejects.toThrow();
        }
        const persisted = await publisher.getStatus(id);
        expect(persisted?.status).toBe(state);
        expect(persisted?.request).toEqual(request);
        expect(persisted?.jobId).toBe(id);
      }
    } finally {
      await store.close();
    }
  }), propertyOptions());
}, 30_000);
