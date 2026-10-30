import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ExecutionReceiptJournal, ReceiptProgress } from '@origintrail-official/dkg-semantic-runtime';
import { Parser } from 'n3';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { type PersistenceEvidence, type SemanticMemoryLayer, SemanticProgramError } from './semantic-runtime-types.js';
import { historyIsAtLayer, historyLayerLabel } from './semantic-runtime-values.js';

type Triple = { subject: string; predicate: string; object: string };
function tripleKey(q: Triple): string {
  const [parsed] = new Parser({ format: 'N-Triples' }).parse(
    `${sparqlIri(q.subject)} ${sparqlIri(q.predicate)} ${q.object.startsWith('"') ? q.object : sparqlIri(q.object)} .`);
  const term = parsed.object;
  return JSON.stringify([parsed.subject.value, parsed.predicate.value, term.termType, term.value,
    term.termType === 'Literal' ? term.language.toLowerCase() : '', term.termType === 'Literal' ? term.datatype.value : '']);
}

/** Layer labels include drafts. Only exact content plus the pinned finalized pointer
 * can acknowledge a receipt. Issued uncertain finalize/share/publish calls are read back,
 * never dispatched a second time. Every new mutation has a fresh live authority check. */
export async function persistKnowledgeAsset(
  agent: DKGAgent, contextGraphId: string, name: string, agentAddress: string, quads: Triple[],
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>, targetLayer: SemanticMemoryLayer,
  errors: { layerConflict: string; shareFailed: string; publishFailed: string; subject: string },
  assertAuthorized: () => Promise<void>, journal?: ExecutionReceiptJournal,
): Promise<PersistenceEvidence> {
  const lane = { agentAddress };
  let history = initialHistory;
  let progress: ReceiptProgress = journal?.progress ?? { phase: 'prepared' };
  const save = (next: ReceiptProgress) => { journal?.checkpoint(next); progress = next; };
  const conflict = (message: string): never => { throw new SemanticProgramError(errors.layerConflict, message, 409); };
  const uncertain = (): never => { throw new SemanticProgramError('RECEIPT_REQUIRES_RECONCILIATION',
    `${errors.subject} has an issued ${progress.phase} awaiting exact lifecycle evidence; retry the same invocation`, 409); };
  const read = () => agent.assertion.history(contextGraphId, name, lane);
  const atLayer = () => history && progress.assertion && historyIsAtLayer(history, targetLayer)
    && history[({ wm: 'wmCurrentAssertion', swm: 'swmCurrentAssertion', vm: 'vmCurrentAssertion' } as const)[targetLayer]] === progress.assertion;
  const done = async (): Promise<PersistenceEvidence> => {
    if (!atLayer()) uncertain();
    await assertAuthorized();
    save({ ...progress, phase: 'completed' });
    return { layer: targetLayer, ...(targetLayer === 'vm' ? { ual: history!.publishedUal! } : {}) };
  };
  await assertAuthorized();
  if (atLayer()) return done();
  if (progress.phase === 'completed' || progress.phase === 'publish') uncertain();
  if (history?.memoryLayer && ({ WM: 0, SWM: 1, VM: 2 }[history.memoryLayer] ?? 3) > ({ wm: 0, swm: 1, vm: 2 }[targetLayer])) {
    conflict(`${errors.subject} already exists in ${historyLayerLabel(history)}`);
  }
  if (!history) {
    if (progress.phase !== 'prepared') uncertain();
    await assertAuthorized();
    save({ phase: 'create' });
    await agent.assertion.create(contextGraphId, name, lane);
    history = await read();
    if (!history) uncertain();
  }
  if (!progress.assertion) {
    const expected = new Set(quads.map(tripleKey));
    const actual = new Set((await agent.assertion.query(contextGraphId, name, lane)).map(tripleKey));
    if ([...actual].some(q => !expected.has(q))) conflict(`${errors.subject} has different receipt content`);
    if (!history!.wmCurrentAssertion) {
      if (progress.phase === 'finalize') uncertain();
      const missing = quads.filter(q => !actual.has(tripleKey(q)));
      if (missing.length) {
        await assertAuthorized();
        save({ phase: 'write' });
        await agent.assertion.write(contextGraphId, name, missing, lane);
      }
      const written = new Set((await agent.assertion.query(contextGraphId, name, lane)).map(tripleKey));
      if (written.size !== expected.size || [...written].some(q => !expected.has(q))) conflict(`${errors.subject} write is incomplete or conflicts`);
      await assertAuthorized();
      save({ phase: 'finalize' });
      await agent.assertion.finalize(contextGraphId, name, lane);
      history = await read();
    } else if (actual.size !== expected.size) conflict(`${errors.subject} sealed content differs from the expected receipt`);
    if (!history?.wmCurrentAssertion) uncertain();
    save({ phase: 'sealed', assertion: history!.wmCurrentAssertion });
  }
  if (atLayer()) return done();
  if (history!.wmCurrentAssertion !== progress.assertion) conflict(`${errors.subject} finalized assertion changed`);
  if (progress.phase === 'share') {
    if (history!.swmCurrentAssertion !== progress.assertion) uncertain();
    save({ ...progress, phase: 'shared' });
  }
  if (targetLayer !== 'wm') {
    if (history!.swmCurrentAssertion && history!.swmCurrentAssertion !== progress.assertion) conflict(`${errors.subject} Shared Working Memory assertion changed`);
    if (history!.swmCurrentAssertion !== progress.assertion) {
      await assertAuthorized();
      save({ ...progress, phase: 'share' });
      const share = await agent.assertion.promote(contextGraphId, name, lane);
      if (!share.publishReady) throw new SemanticProgramError(errors.shareFailed, `${errors.subject} share was not confirmed`, 502);
      history = await read();
      if (history?.swmCurrentAssertion !== progress.assertion) uncertain();
    }
    save({ ...progress, phase: 'shared' });
  }
  if (targetLayer === 'vm') {
    await assertAuthorized();
    save({ ...progress, phase: 'publish' });
    const publication = await agent.publishFromFinalizedAssertion(contextGraphId, name, lane);
    if (publication.status !== 'confirmed' || publication.contextGraphError || !publication.ual) {
      throw new SemanticProgramError(errors.publishFailed, `${errors.subject} publication was not confirmed`, 502);
    }
    history = await read();
    if (history?.publishedUal !== publication.ual) uncertain();
  }
  return done();
}
