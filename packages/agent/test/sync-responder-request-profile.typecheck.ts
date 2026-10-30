import { resolveSyncResponderRequestProfile } from '../src/sync/responder/page-framing-policy.js';

resolveSyncResponderRequestProfile({
  legacyLimit: 128, includeSharedMemory: false, phase: 'data', assetUals: [],
  // @ts-expect-error All resource decisions derive from one normalized request.
  framing: { usesByteBudgetPage: true, limit: 8192, maxPageBytes: 16 * 1024 * 1024 },
});
