// SPDX-License-Identifier: Apache-2.0

import {
  createCertificationRouteState,
  createCertificationSynchronization,
  startCertificationRouteServer,
  type CertificationRouteOptions,
} from './helpers/rfc64-certification-route-daemon.js';

const options = {
  contextGraphId: '0'.repeat(64),
  catalogSwmAsk: 'ASK { ?s ?p ?o }',
  nodeAddress: '0x1111111111111111111111111111111111111111',
  nodeCommit: '0123456789abcdef0123456789abcdef01234567',
  networkId: 'otp-testnet-2160',
} satisfies CertificationRouteOptions;
const source = createCertificationRouteState('source');
const receiver = createCertificationRouteState('receiver');
const synchronization = createCertificationSynchronization(receiver);
const server = startCertificationRouteServer(source, options, synchronization);

// @ts-expect-error The reusable fixture admits only the two certification roles.
createCertificationRouteState('observer');
// @ts-expect-error A commit is a required part of the daemon contract fixture.
startCertificationRouteServer(source, { ...options, nodeCommit: undefined });

void server;
