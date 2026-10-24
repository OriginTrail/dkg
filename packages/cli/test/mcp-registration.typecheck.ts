import type { DesiredRegistration } from '../src/mcp-client-config.js';

const desired = {
  command: '/usr/bin/node',
  args: ['/opt/dkg/cli.js', 'mcp', 'serve'],
  env: { DKG_HOME: '/srv/dkg' },
} satisfies DesiredRegistration;

// Persisted extension fields are merged by the writer; callers cannot smuggle
// them into the DKG-owned desired shape.
// @ts-expect-error arbitrary top-level desired fields are not owned
const extraTopLevel: DesiredRegistration = { ...desired, cwd: '/tmp' };
// @ts-expect-error arbitrary desired env fields are not owned
const extraEnv: DesiredRegistration = { ...desired, env: { ...desired.env, HTTPS_PROXY: 'http://proxy' } };

void [desired, extraTopLevel, extraEnv];
