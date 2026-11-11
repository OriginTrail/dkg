import type { ProgramExecutionTrace } from './types.js';
/** Validate diagnostic wire data before exposing it to SDK clients. */
export function executionTrace(value: unknown, executionIri: string): ProgramExecutionTrace | undefined {
  if (value === undefined) return undefined;
  const v = value as ProgramExecutionTrace;
  const states = ['running', 'succeeded', 'failed', 'interrupted'];
  const duration = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (!v || v.version !== 1 || v.executionIri !== executionIri || typeof v.startedAt !== 'string' || !states.includes(v.status)
    || !duration(v.durationMs) || !Array.isArray(v.calls) || v.calls.length > 256
    || v.calls.some(c => !c || typeof c.id !== 'string' || !['tool', 'program'].includes(c.kind) || typeof c.target !== 'string'
      || typeof c.startedAt !== 'string' || !states.includes(c.status) || !duration(c.durationMs)
      || (c.error !== undefined && typeof c.error !== 'string') || (c.executionIri !== undefined && typeof c.executionIri !== 'string')
      || (c.resultTruncated !== undefined && typeof c.resultTruncated !== 'boolean'))
    || (v.failure && (typeof v.failure.location !== 'string' || typeof v.failure.message !== 'string'))
    || JSON.stringify(v).length > 1_048_576) throw new TypeError('Invalid execution trace');
  return v;
}
