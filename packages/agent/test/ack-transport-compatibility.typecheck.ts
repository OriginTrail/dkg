import type { DKGAgent } from '../src/index.js';
import type { ACKTransport } from '@origintrail-official/dkg-publisher';

declare const agent: DKGAgent;
declare const transport: ACKTransport;
void agent.createACKTransportFactory()().getConnectedCorePeers();
void transport.getConnectedCorePeers('/dkg/10.0.1/storage-ack');
void transport.getConnectedCorePeers('/dkg/10.0.1/storage-ack', 2);
