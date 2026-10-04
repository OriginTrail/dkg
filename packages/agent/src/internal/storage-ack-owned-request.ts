// SPDX-License-Identifier: Apache-2.0

import { type ACKCollectorDeps } from '@origintrail-official/dkg-publisher';

interface ACKReliableMessenger {
  sendRequestOwned(
    peerId: string,
    protocol: string,
    data: Uint8Array,
    opts: { timeoutMs: number },
  ): Promise<{ delivered: boolean; error?: unknown; response?: Uint8Array }>;
}

export function createACKSendP2P(input: {
  messenger: ACKReliableMessenger;
  timeoutMs: number;
}): ACKCollectorDeps['sendP2P'] {
  return async (peerId: string, protocol: string, data: Uint8Array) => {
    const sendResult = await input.messenger.sendRequestOwned(peerId, protocol, data, {
      timeoutMs: input.timeoutMs,
    });
    if (!sendResult.delivered) {
      throw new Error(`substrate send already in flight (transport): ${sendResult.error}`);
    }
    if (!sendResult.response) {
      throw new Error('substrate delivered (transport) without response');
    }
    return sendResult.response;
  };
}
