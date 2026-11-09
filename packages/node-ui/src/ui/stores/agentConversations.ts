import { create } from 'zustand';
import type { LocalAgentAttachmentDraft, LocalAgentMessage } from '../components/Shell/PanelRight/types.js';

/**
 * Conversation state for the agent panel, keyed by conversation. It lives
 * outside the panel so the panel can unmount when it's closed (stopping its
 * polling and listeners) while drafts, queued files, messages and sends in
 * flight carry on and are there when it opens again.
 */
interface AgentConversations {
  messages: Record<string, LocalAgentMessage[]>;
  inputs: Record<string, string>;
  sending: Record<string, boolean>;
  historyLoaded: Record<string, boolean>;
  attachmentDrafts: Record<string, LocalAgentAttachmentDraft[]>;
}

type Field = keyof AgentConversations;
type Update<T> = T | ((previous: T) => T);

const EMPTY: AgentConversations = { messages: {}, inputs: {}, sending: {}, historyLoaded: {}, attachmentDrafts: {} };

export const useAgentConversations = create<AgentConversations>(() => ({ ...EMPTY }));

/** Like `useState` for one map, but the value outlives the component. */
export function useConversationField<K extends Field>(field: K): [AgentConversations[K], (update: Update<AgentConversations[K]>) => void] {
  const value = useAgentConversations((s) => s[field]);
  return [value, setters[field] as (update: Update<AgentConversations[K]>) => void];
}

function setterFor<K extends Field>(field: K) {
  return (update: Update<AgentConversations[K]>) => useAgentConversations.setState((s) => ({
    [field]: typeof update === 'function' ? (update as (p: AgentConversations[K]) => AgentConversations[K])(s[field]) : update,
  }) as Partial<AgentConversations>);
}

// One stable setter per field, so effects that depend on them don't re-run.
const setters: { [K in Field]: (update: Update<AgentConversations[K]>) => void } = {
  messages: setterFor('messages'),
  inputs: setterFor('inputs'),
  sending: setterFor('sending'),
  historyLoaded: setterFor('historyLoaded'),
  attachmentDrafts: setterFor('attachmentDrafts'),
};

/** For tests: start with no conversations. */
export const resetAgentConversations = () => useAgentConversations.setState({ ...EMPTY });
