# @dkg/adapter-elizaos

[ElizaOS](https://elizaos.ai) plugin adapter for DKG V9. Turns any ElizaOS agent into a DKG node with knowledge publishing, querying, agent discovery, and skill invocation capabilities.

## Features

- **dkgPlugin** — drop-in ElizaOS plugin that registers all DKG actions, providers, and the node service
- **dkgService** — manages the DKG node lifecycle within ElizaOS's service system (start/stop with the agent)
- **Actions** — `dkgPublish`, `dkgQuery`, `dkgFindAgents`, `dkgSendMessage`, `dkgInvokeSkill`
- **dkgKnowledgeProvider** — injects DKG knowledge graph context into the agent's memory/reasoning

## Usage

```typescript
import { dkgPlugin } from '@dkg/adapter-elizaos';

const agent = new ElizaAgent({
  plugins: [dkgPlugin],
  // ... other config
});
```

Once the plugin is loaded, the agent can:

- Publish data to DKG paranets via natural language commands
- Query the knowledge graph for context during conversations
- Discover and communicate with other DKG agents
- Invoke remote agent skills

## Internal Dependencies

- `@dkg/agent` — DKG agent runtime
- `@dkg/core` — P2P node, configuration
- `@dkg/storage` — triple store for local data
