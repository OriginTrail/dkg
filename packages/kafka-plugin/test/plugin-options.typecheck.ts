import { createKafkaPlugin } from '../src/index.js';

// The public factory is the contract a consumer actually types against. Narrowing only the
// internal handler option left this compiling, so the guarantee has to be asserted HERE — and a
// runtime test cannot express it, because the property is a compile error.

// A valid publish option is accepted.
void createKafkaPlugin({ publishOptions: { accessPolicy: 'public' } });

// The options this plugin documents type-check together.
void createKafkaPlugin({
  publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'], subGraphName: 'streams' },
});

// @ts-expect-error A KNOWN option with a nonsense value is rejected. As a loose
// `Record<string, unknown>` this compiled clean and reached the agent unchecked.
void createKafkaPlugin({ publishOptions: { accessPolicy: 42 } });

// @ts-expect-error The submitter is set from the authenticated request identity, so it is not
// plugin configuration. Advertising it would let a caller set it, type-check, and have the
// handler silently replace the value.
void createKafkaPlugin({ publishOptions: { admittedByAgentAddress: '0xattacker' } });

// UNKNOWN options still compile, and that is deliberate rather than an oversight. The published
// contract was `Record<string, unknown>` and the runtime forwards whatever it receives, so
// rejecting these would break existing consumers — `{ localOnly: true }` is a configuration that
// works today and materially changes behaviour.
//
// The cost is real and worth stating rather than hiding: a typo like `accessPolicyy` is forwarded
// silently instead of caught, and a future agent option becomes accepted Kafka configuration
// without anyone deciding it should be. Tightening to a strict allow-list is the better end state
// and needs a major release with a migration note — tracked on #2305.
//
// These rows exist so the trade is visible in the suite, and so that flipping to the strict form
// later is a deliberate edit here rather than a silent behaviour change.
void createKafkaPlugin({ publishOptions: { localOnly: true } });
void createKafkaPlugin({ publishOptions: { accessPolicyy: 'public' } });
