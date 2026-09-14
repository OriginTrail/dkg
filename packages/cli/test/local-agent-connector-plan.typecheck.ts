import type {
  LocalAgentConnectPlan,
  LocalAgentConnectorPlan,
} from '../src/daemon/local-agent-connectors/types.js';

const connectorPlan = {
  ok: true,
  state: { runtime: { status: 'ready', ready: true } },
} satisfies LocalAgentConnectorPlan;

const connectorWithAttachHandle = {
  ok: true,
  state: {},
  afterCommit: () => ({
    notice: 'scheduled',
    attachJob: {
      started: true,
      job: Promise.resolve(),
      controller: new AbortController(),
    },
  }),
} satisfies LocalAgentConnectorPlan;

const preparedPlan = {
  ok: true,
  state: {
    name: 'Hermes',
    capabilities: { chatAttachments: true },
    manifest: { packageName: '@origintrail/hermes' },
  },
} satisfies LocalAgentConnectPlan;

const connectorCannotReplaceRegistration: LocalAgentConnectorPlan = {
  ok: true,
  state: {
    // @ts-expect-error registration identity is owned by the outer connect planner
    name: 'replacement',
  },
};

const connectorCannotReplaceCapabilities: LocalAgentConnectorPlan = {
  ok: true,
  state: {
    // @ts-expect-error connector attach state does not own capability registration
    capabilities: { chatAttachments: false },
  },
};

const connectorCannotReplaceManifest: LocalAgentConnectorPlan = {
  ok: true,
  state: {
    // @ts-expect-error connector attach state does not own manifest registration
    manifest: { packageName: 'replacement' },
  },
};

void [
  connectorPlan,
  connectorWithAttachHandle,
  preparedPlan,
  connectorCannotReplaceRegistration,
  connectorCannotReplaceCapabilities,
  connectorCannotReplaceManifest,
];
