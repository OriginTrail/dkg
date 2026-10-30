import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { canonicalizeJson, sparqlIri, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { RuntimeAdapterOperation, SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { Parser } from 'n3';

export type AssetLayer = 'wm' | 'swm' | 'vm';
interface Triple { subject: string; predicate: string; object: string }
interface AssetInput { quads: Triple[] }
interface Checkpoint {
  phase: 'create' | 'write' | 'finalize' | 'sealed' | 'share' | 'shared' | 'publish' | 'completed';
  assertion?: string;
  output?: string;
}
const MAX_BYTES = 128 * 1024;
const MAX_QUADS = 256;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => canonicalizeJson(value as CanonicalJsonValue, { maxBytes: MAX_BYTES });
function normalizeTriple(q: Triple): Triple {
  const iri = (term: string) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(term)) throw new Error('INVALID_ASSET_IRI');
    return sparqlIri(term);
  };
  const parsed = new Parser({ format: 'N-Triples' }).parse(`${iri(q.subject)} ${iri(q.predicate)} ${q.object.startsWith('"') ? q.object : iri(q.object)} .`);
  if (parsed.length !== 1 || parsed[0].subject.termType !== 'NamedNode'
    || !['NamedNode', 'Literal'].includes(parsed[0].object.termType)) throw new Error('INVALID_ASSET_TRIPLE');
  const term = parsed[0].object;
  const object = term.termType === 'Literal'
    ? JSON.stringify(term.value) + (term.language ? `@${term.language.toLowerCase()}`
      : term.datatype.value === 'http://www.w3.org/2001/XMLSchema#string' ? '' : `^^${iri(term.datatype.value)}`)
    : term.value;
  return { subject: parsed[0].subject.value, predicate: parsed[0].predicate.value, object };
}
const tripleKey = (q: Triple) => { const n = normalizeTriple(q); return canonical([n.subject, n.predicate, n.object]); };

/** Destination and identity come only from the approved execution, never tool input. */
export function createAssetCreationAdapter(
  agent: DKGAgent,
  contextGraphId: string,
  layer: AssetLayer,
  agentAddress: string,
  store: SemanticRuntimeStore | undefined,
  assertAuthorized: () => Promise<void>,
): RuntimeAdapterOperation<AssetInput, string> {
  const lane = { agentAddress };
  const authorize = async () => {
    await assertAuthorized();
    const probe = await agent.probeContextGraphWritePreflight(contextGraphId, { callerAgentAddress: agentAddress });
    if (!probe.storeAvailable || probe.exists !== true || probe.callerAuthorized !== true
      || !(probe.hasLocalContent === true || (probe.inMemorySubscription?.subscribed && probe.inMemorySubscription.synced))) {
      throw new Error('ASSET_GRAPH_WRITE_FORBIDDEN');
    }
    await assertAuthorized();
  };
  const nameFor = (effectId: string) => `program-asset-${hash(canonical([contextGraphId, agentAddress.toLowerCase(), effectId]))}`;
  const atLayer = (history: Awaited<ReturnType<DKGAgent['assertion']['history']>>, checkpoint: Checkpoint) => {
    if (!history || !checkpoint.assertion) return false;
    if (layer === 'wm') return history.memoryLayer === 'WM' && history.wmCurrentAssertion === checkpoint.assertion;
    if (layer === 'swm') return history.memoryLayer === 'SWM' && history.swmCurrentAssertion === checkpoint.assertion;
    return history.memoryLayer === 'VM' && history.vmCurrentAssertion === checkpoint.assertion && Boolean(history.publishedUal);
  };
  const receipt = (name: string, input: AssetInput, assertion: string, ual?: string) => canonical({
    kind: 'asset-created', name, contextGraphId, layer, authorAgentAddress: agentAddress,
    contentDigest: hash(canonical(input)), assertion, ...(ual ? { ual } : {}),
  });
  const run: RuntimeAdapterOperation<AssetInput, string>['dispatch'] = async (authorization, input) => {
    if (!store) throw new Error('ASSET_JOURNAL_REQUIRED');
    await authorize();
    const name = nameFor(authorization.effectId);
    const saved = store.adapterCheckpoint(authorization.effectId);
    let version = saved?.version ?? 0;
    let checkpoint: Checkpoint = saved ? JSON.parse(new TextDecoder().decode(saved.payload)) : { phase: 'create' };
    const save = (next: Checkpoint) => {
      version = store.writeAdapterCheckpoint(authorization.effectId, authorization.requestDigest,
        new TextEncoder().encode(canonical(next)), version);
      checkpoint = next;
    };
    let history = await agent.assertion.history(contextGraphId, name, lane);
    if (!saved) {
      if (history) throw new Error('ASSET_NAME_ALREADY_EXISTS');
      save(checkpoint);
    }
    if (atLayer(history, checkpoint)) {
      await authorize();
      const output = receipt(name, input, checkpoint.assertion!, history?.publishedUal ?? undefined);
      save({ ...checkpoint, phase: 'completed', output });
      return { status: 'succeeded', output, evidenceRef: history?.publishedUal || `urn:dkg:program-asset:${name}` };
    }
    // An issued share/publish/finalize may still be completing. Only read-back
    // evidence can resolve it; never launch a second ambiguous lifecycle call.
    if (checkpoint.phase === 'publish' || checkpoint.phase === 'share' || checkpoint.phase === 'completed') {
      if (checkpoint.phase !== 'share' || history?.swmCurrentAssertion !== checkpoint.assertion) {
        throw new Error('ASSET_CREATION_REQUIRES_RECONCILIATION');
      }
      save({ ...checkpoint, phase: 'shared' });
    }
    if (!history) {
      if (checkpoint.phase !== 'create') throw new Error('ASSET_LIFECYCLE_STATE_LOST');
      await authorize();
      await agent.assertion.create(contextGraphId, name, lane);
      history = await agent.assertion.history(contextGraphId, name, lane);
    }
    if (!history) throw new Error('ASSET_CREATE_NOT_CONFIRMED');
    if (!checkpoint.assertion) {
      const existing = await agent.assertion.query(contextGraphId, name, lane);
      const expected = new Set(input.quads.map(tripleKey));
      const actual = new Set(existing.map(tripleKey));
      if ([...actual].some((triple) => !expected.has(triple))) throw new Error('ASSET_CONTENT_CONFLICT');
      if (checkpoint.phase === 'finalize' && !history.wmCurrentAssertion) throw new Error('ASSET_CREATION_REQUIRES_RECONCILIATION');
      if (!history.wmCurrentAssertion) {
        const missing = input.quads.filter((triple) => !actual.has(tripleKey(triple)));
        if (missing.length) {
          await authorize();
          save({ phase: 'write' });
          await agent.assertion.write(contextGraphId, name, missing, lane);
        }
        const written = await agent.assertion.query(contextGraphId, name, lane);
        if (canonical([...new Set(written.map(tripleKey))].sort()) !== canonical([...expected].sort())) throw new Error('ASSET_CONTENT_CONFLICT');
        await authorize();
        save({ phase: 'finalize' });
        await agent.assertion.finalize(contextGraphId, name, lane);
        history = await agent.assertion.history(contextGraphId, name, lane);
      } else if (canonical([...actual].sort()) !== canonical([...expected].sort())) {
        throw new Error('ASSET_CONTENT_CONFLICT');
      }
      if (!history?.wmCurrentAssertion) throw new Error('ASSET_FINALIZE_NOT_CONFIRMED');
      save({ phase: 'sealed', assertion: history.wmCurrentAssertion });
    }
    if (layer !== 'wm' && checkpoint.phase === 'sealed') {
      await authorize();
      save({ ...checkpoint, phase: 'share' });
      const shared = await agent.assertion.promote(contextGraphId, name, lane);
      if (!shared.publishReady) throw new Error('ASSET_SHARE_NOT_CONFIRMED');
      save({ ...checkpoint, phase: 'shared' });
    }
    if (layer === 'vm') {
      await authorize();
      save({ ...checkpoint, phase: 'publish' });
      const publication = await agent.publishFromFinalizedAssertion(contextGraphId, name, lane);
      if (publication.status !== 'confirmed' || publication.contextGraphError || !publication.ual) throw new Error('ASSET_PUBLISH_NOT_CONFIRMED');
      history = await agent.assertion.history(contextGraphId, name, lane);
      if (!atLayer(history, checkpoint) || history?.publishedUal !== publication.ual) throw new Error('ASSET_PUBLISH_NOT_CONFIRMED');
      save({ ...checkpoint, phase: 'completed', output: receipt(name, input, checkpoint.assertion!, publication.ual) });
    } else {
      history = await agent.assertion.history(contextGraphId, name, lane);
      if (!atLayer(history, checkpoint)) throw new Error('ASSET_LAYER_NOT_CONFIRMED');
      save({ ...checkpoint, phase: 'completed', output: receipt(name, input, checkpoint.assertion!) });
    }
    await authorize();
    return { status: 'succeeded', output: checkpoint.output!, evidenceRef: `urn:dkg:program-asset:${name}` };
  };
  return {
    id: 'dkg/asset-create', version: '1', witInterface: 'origintrail:semantic-runtime/asset-create@0.1.0',
    implementationVersion: '1',
    implementationHash: hash(readFileSync(fileURLToPath(import.meta.url), 'utf8') + canonical([contextGraphId, layer, agentAddress])),
    effectClass: 'asset-creation', verb: 'create-asset', idempotencyClass: 'conditionally_idempotent',
    reconciliationRule: 'read-back-exact-assertion-before-checkpointed-continuation',
    validateInput(value): AssetInput {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'quads')) throw new Error('INVALID_ASSET_CONTENT');
      const quads = (value as AssetInput).quads;
      if (!Array.isArray(quads) || !quads.length || quads.length > MAX_QUADS || Buffer.byteLength(canonical(value)) > MAX_BYTES) throw new Error('INVALID_ASSET_CONTENT');
      const normalized = quads.map((q) => {
        if (!q || Object.keys(q).sort().join(',') !== 'object,predicate,subject'
          || [q.subject, q.predicate, q.object].some((term) => typeof term !== 'string' || term.length > 16_384)) throw new Error('INVALID_ASSET_TRIPLE');
        return normalizeTriple(q);
      });
      return { quads: [...new Map(normalized.map((q) => [tripleKey(q), q])).values()].sort((a, b) => tripleKey(a).localeCompare(tripleKey(b))) };
    },
    dispatch: run,
    resume: run,
    async reconcile(effect, input) {
      await authorize();
      const saved = store?.adapterCheckpoint(effect.effectId);
      if (!saved) return { status: 'unknown', evidenceRef: 'urn:dkg:asset:missing-checkpoint' };
      const checkpoint: Checkpoint = JSON.parse(new TextDecoder().decode(saved.payload));
      const name = nameFor(effect.effectId);
      const history = await agent.assertion.history(contextGraphId, name, lane);
      if (!atLayer(history, checkpoint)) return { status: 'unknown', evidenceRef: 'urn:dkg:asset:incomplete-lifecycle' };
      await authorize();
      const output = receipt(name, input, checkpoint.assertion!, history?.publishedUal ?? undefined);
      store!.writeAdapterCheckpoint(effect.effectId, effect.requestDigest,
        new TextEncoder().encode(canonical({ ...checkpoint, phase: 'completed', output })), saved.version);
      return { status: 'applied', evidenceRef: `urn:dkg:program-asset:${name}`, output };
    },
    couldHaveReachedTarget: () => true,
  };
}
