import type { NormalizedRpcUsageWindow } from '../src/index.js';

// A downstream consumer constructing the pre-getLogs normalized shape remains
// source-compatible. New attribution is optional on the released window type
// and becomes concrete only after normalizeRpcUsageWindow().
const legacyNormalizedWindow: NormalizedRpcUsageWindow = {
  byMethod: {},
  ethCallByConsumer: {},
  lifetimeTotal: 0,
};

void legacyNormalizedWindow;
