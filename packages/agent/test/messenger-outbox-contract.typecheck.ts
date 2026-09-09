import { DKGAgent, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import { Messenger } from '@origintrail-official/dkg-agent/dist/p2p/messenger.js';
import { BoundedProtocolOutbox, ProtocolOutbox, type ProtocolOutboxStore, type BoundedProtocolOutboxStore,
  type ProtocolRouter, type ProtocolOutboxEntry, type ProtocolOutboxMetadata } from '@origintrail-official/dkg-core';

declare const unboundedStore: ProtocolOutboxStore;
declare const boundedStore: BoundedProtocolOutboxStore;
declare const router: ProtocolRouter;
// @ts-expect-error Automatic retries require the complete bounded store contract.
new Messenger({ router, outboxStore: unboundedStore });
new Messenger({ router, outboxStore: boundedStore });
type AgentOutboxStore = NonNullable<DKGAgentConfig['messengerStores']>['outboxStore'];
// @ts-expect-error Public SDK configuration must also reject stores lacking byte-bounded reads.
const rejected: AgentOutboxStore = unboundedStore;
const accepted: AgentOutboxStore = boundedStore;
void rejected; void accepted;

declare const agent: DKGAgent;
declare const messenger: Messenger;
const legacyChat: ProtocolOutboxEntry[] = agent.listMessageOutbox();
const chatMetadata: ProtocolOutboxMetadata[] = agent.listMessageOutboxMetadata();
const legacyMessenger: ProtocolOutboxEntry[] | undefined = messenger.listOutbox();
const messengerMetadata: ProtocolOutboxMetadata[] = messenger.listOutboxMetadata();
const legacyDue: ProtocolOutboxEntry[] = new ProtocolOutbox(unboundedStore).duePage(Date.now());
void legacyChat; void chatMetadata; void legacyMessenger; void messengerMetadata; void legacyDue;

// Automatic retries do not require legacy full-payload inspection methods.
type AutomaticStore = Pick<BoundedProtocolOutboxStore,
  'enqueue' | 'markDelivered' | 'hasEntry' | 'size' | 'hasPendingFor'
  | 'readDuePage' | 'listMetadata' | 'dropExpiredMetadata' | 'recordRetryFailure' | 'queueStats'>;
declare const automaticOnly: AutomaticStore;
new Messenger({ router, outboxStore: automaticOnly });
const automaticOutbox = new BoundedProtocolOutbox(automaticOnly);
const unavailableInspection: undefined | { list(): ProtocolOutboxEntry[] } = automaticOutbox.payloadInspection();
const automaticConfig: AgentOutboxStore = automaticOnly;
void automaticConfig; void unavailableInspection;
