// SPDX-License-Identifier: Apache-2.0

export class MemoryProtocolRouterV1 {
  handlers = new Map();
  remote = null;

  constructor(peerId) {
    this.peerId = peerId;
  }

  register(protocol, handler) {
    this.handlers.set(protocol, handler);
  }

  unregister(protocol) {
    this.handlers.delete(protocol);
  }

  async send(_remotePeerId, protocol, data) {
    const handler = this.remote?.handlers.get(protocol);
    if (handler === undefined) throw new Error(`missing in-memory handler for ${protocol}`);
    return handler(data, { toString: () => this.peerId });
  }
}

export function createMemoryProtocolRouterPairV1() {
  const provider = new MemoryProtocolRouterV1('provider-peer');
  const receiver = new MemoryProtocolRouterV1('receiver-peer');
  provider.remote = receiver;
  receiver.remote = provider;
  return Object.freeze([provider, receiver]);
}
