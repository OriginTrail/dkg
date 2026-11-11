/**
 * What a promote or publish came to: one tone and one message, kept as one
 * value from the action to the line that shows it. A run that went through
 * with something to flag (a partial publish, an unknown on-chain outcome) is
 * a warning, not a success.
 */
export type OutcomeTone = 'success' | 'warning' | 'danger';
export interface ActionOutcome { tone: OutcomeTone; text: string }

export const succeeded = (text: string): ActionOutcome => ({ tone: 'success', text });
export const succeededWithWarning = (text: string, warn: boolean): ActionOutcome => ({ tone: warn ? 'warning' : 'success', text });
export const failed = (text: string): ActionOutcome => ({ tone: 'danger', text });

