import { readProgramCallHistory, type SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { n8nRecord, type NativeN8nGrant } from './semantic-runtime-n8n-contract.js';

export type NativeN8nCheckpoint = {
  kind: 'n8n-native-v1'; workflowId: string; workflowSha256: string;
  executionId: string; versionId: string; observed: boolean;
};

/** Keep the existing JSON byte representation; both adapter and continuation
 * inspection use this codec to validate a durable provider acknowledgement.
 */
export function encodeNativeN8nCheckpoint(value: NativeN8nCheckpoint): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeNativeN8nCheckpoint(payload: Uint8Array, grant: NativeN8nGrant): NativeN8nCheckpoint {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(payload)); }
  catch { throw new Error('N8N_CHECKPOINT_INVALID'); }
  if (!n8nRecord(value) || value.kind !== 'n8n-native-v1'
    || value.workflowId !== grant.workflowId || value.workflowSha256 !== grant.workflowSha256
    || typeof value.executionId !== 'string' || !/^\d{1,20}$/.test(value.executionId)
    || typeof value.versionId !== 'string' || !value.versionId || typeof value.observed !== 'boolean')
    throw new Error('N8N_CHECKPOINT_INVALID');
  return value as NativeN8nCheckpoint;
}

export function readNativeN8nCheckpoint(store: SemanticRuntimeStore, effectId: string, grant: NativeN8nGrant): NativeN8nCheckpoint | null {
  const saved = store.adapterCheckpoint(effectId);
  return saved ? decodeNativeN8nCheckpoint(saved.payload, grant) : null;
}

/** Return only acknowledged native effects eligible for inspection. Mixed
 * execution histories and missing or malformed checkpoints cannot be replayed.
 */
export function nativeN8nContinuationEffects(store: SemanticRuntimeStore, executionIri: string, grant: NativeN8nGrant): Set<string> | null {
  // Declared child pins are not evidence of child calls. Only actual call
  // history decides whether this was an exclusively native execution.
  let calls;
  try { calls = readProgramCallHistory(store, executionIri).calls; }
  catch { return null; }
  if (!calls.length || calls.some(call => call.kind !== 'tool' || call.target !== grant.toolIri)) return null;
  const effects = store.effectsForExecution(executionIri);
  if (!effects.length) return null;
  for (const effect of effects) {
    // Succeeded effects can still lack a parent receipt after a crash.
    if (effect.adapterId !== 'n8n/workflow' || effect.resource !== grant.toolIri
      || !['succeeded', 'unknown', 'reconciling', 'manual_review_required'].includes(effect.state)) return null;
    try { if (!readNativeN8nCheckpoint(store, effect.effectId, grant)) return null; }
    catch { return null; }
  }
  return new Set(effects.map(effect => effect.effectId));
}
