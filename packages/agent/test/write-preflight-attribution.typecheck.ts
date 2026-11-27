import type { ContextGraphWritePreflightProbe } from '../src/dkg-agent-types.js';
import type { WritePreflightFailure, WritePreflightFailureSite } from '../src/write-preflight-attribution.js';

const probeFailure: WritePreflightFailure = { site: 'caller-access', kind: 'unknown' };
const attribution: ContextGraphWritePreflightProbe['failureAttribution'] = [probeFailure];

// @ts-expect-error List fallback is owned by the daemon, not an agent probe.
const daemonSite: WritePreflightFailureSite = 'list';
// @ts-expect-error A failed daemon probe invocation cannot be emitted by the probe itself.
const daemonFailure: WritePreflightFailure = { site: 'exact-probe', kind: 'unknown' };

void [attribution, daemonSite, daemonFailure];
