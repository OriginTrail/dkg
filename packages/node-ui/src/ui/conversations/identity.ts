import { getDefaultLocalAgentSessionId } from '../api.js';

/** Which conversation a session is: one resolver, so every caller derives the same state key. */
export function getLocalAgentConversationStateKey(
  integrationId: string,
  sessionId: string | null,
): string {
  return sessionId?.trim() || `integration:${integrationId}`;
}

export function resolveLocalAgentConversation(args: {
  integrationId: string;
  sessionId: string | null;
  defaultSessionId?: string | null;
}): { integrationId: string; sessionId: string | null; stateKey: string } {
  const resolvedSessionId = args.sessionId
    ?? args.defaultSessionId
    ?? getDefaultLocalAgentSessionId(args.integrationId);
  return {
    integrationId: args.integrationId,
    sessionId: resolvedSessionId,
    stateKey: getLocalAgentConversationStateKey(args.integrationId, resolvedSessionId),
  };
}
