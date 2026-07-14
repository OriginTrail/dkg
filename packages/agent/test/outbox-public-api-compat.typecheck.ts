import type { DKGAgent } from '../dist/index.js';

// Compile against the generated package declarations, matching a downstream
// TypeScript consumer rather than an internal source import.
declare const agent: DKGAgent;

for (const entry of agent.listMessageOutbox()) {
  const payload: Uint8Array = entry.payload;
  void payload;
}

const metadataEntries: Array<{ protocol: string; attempts: number }> =
  agent.listMessageOutboxMetadata();
void metadataEntries;
