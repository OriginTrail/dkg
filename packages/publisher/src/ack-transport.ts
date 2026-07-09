import type { ACKCollectorDeps } from './ack-collector.js';

export interface ACKTransport {
  publisherPeerId: string;
  gossipPublish: ACKCollectorDeps['gossipPublish'];
  sendP2P: ACKCollectorDeps['sendP2P'];
  getConnectedCorePeers: ACKCollectorDeps['getConnectedCorePeers'];
  log?: ACKCollectorDeps['log'];
}

export type ACKTransportFactory = () => ACKTransport;
