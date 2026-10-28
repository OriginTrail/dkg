import { LocalModelContextLimitError } from './model-response.js';
import type { InteractionTrace } from './text-trace.js';

type RecoveryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
};

/** Per-turn recovery after explicit pre-inference context rejection. */
export class ContextRecovery {
  private historyRemoved: boolean;
  private finalOnlyUsed = false;

  constructor(hasPriorHistory: boolean, private trace: InteractionTrace) {
    this.historyRemoved = !hasPriorHistory;
  }

  /** Returns true when subsequent inference must use current evidence only. */
  async recover(
    error: unknown,
    messages: RecoveryMessage[],
    currentSystemContext: string,
    hasEvidence: boolean,
    hasTools: boolean,
  ): Promise<boolean> {
    if (!(error instanceof LocalModelContextLimitError)) throw error;
    if (!this.historyRemoved) {
      // Preserve graph scope, the current question and completed tool results.
      messages[0] = {
        role: 'system',
        content: currentSystemContext
          + '\n\nEarlier conversation history was omitted to fit this request. '
          + 'Do not guess entities referred to only in earlier turns; ask for the missing identifier if needed.',
      };
      this.historyRemoved = true;
      await this.trace.write('CONTEXT RECOVERY', {
        action: 'omit-prior-history', contextTokens: error.contextTokens,
      });
      return false;
    }
    if (hasEvidence && hasTools && !this.finalOnlyUsed) {
      // Drop tool schemas, retaining the evidence instead of dispatching again.
      this.finalOnlyUsed = true;
      messages.push({
        role: 'user',
        content: 'The model context limit was reached. Answer concisely from the current tool results only. '
          + 'If the requested list or count is not fully supported, explicitly report a partial answer and what is missing. '
          + 'Do not infer absent facts or repeat tool calls.',
      });
      await this.trace.write('CONTEXT RECOVERY', {
        action: 'finish-from-current-evidence', contextTokens: error.contextTokens,
      });
      return true;
    }
    throw error;
  }
}
