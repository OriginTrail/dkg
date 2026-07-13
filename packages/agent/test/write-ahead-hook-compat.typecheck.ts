import type {
  V10WriteAheadHook,
  V10WriteAheadHookInfo,
} from '@origintrail-official/dkg-chain';

// Compile-time compatibility fixture for external hook emitters. The signal
// was added after the original txHash-only contract, so callers must remain
// able to invoke a hook without manufacturing an AbortSignal.
const hook: V10WriteAheadHook = async (info) => {
  void info.txHash;
  void info.signal;
};

const legacyInfo: V10WriteAheadHookInfo = {
  txHash: `0x${'ab'.repeat(32)}`,
};
const abortAwareInfo: V10WriteAheadHookInfo = {
  txHash: `0x${'cd'.repeat(32)}`,
  signal: new AbortController().signal,
};

void hook(legacyInfo);
void hook(abortAwareInfo);
