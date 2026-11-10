import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BoundedResponseBodyLimitError, readResponseBodyBytesBounded } from '../../packages/http-utils/dist/index.js';
import { parseRdfLiteralTerm, canonicalizeRdfObjectTerm, parseWritableRdfTerm } from '../../packages/rdf-utils/dist/index.js';

const fail = message => Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
export function createNosNodeClient(session, actor, send = fetch) {
  if (!session || actor?.accountId !== session.accountId || actor?.role !== 'owner')
    throw fail('An authenticated nOS owner must start this workflow.');
  return async function call(path, body, query) {
    const response = await send(`${session.controlPlaneUrl}/studio/${session.accountId}/service/node`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(130_000),
      headers: { 'content-type': 'application/json', 'x-nos-workflows-secret': session.secret() },
      body: JSON.stringify({ approvedBy: actor.id,
        ...(actor.startedBy ? { startedBy: actor.startedBy, runKey: actor.runKey, agentVersion: actor.agentVersion,
          toolDigest: actor.toolDigest, approvalDecisionId: actor.approvalDecisionId } : {}),
        method: body === undefined ? 'GET' : 'POST', path,
        ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) }),
    });
    let bytes;
    try { bytes = await readResponseBodyBytesBounded(response, 2 * 1024 * 1024); }
    catch (cause) {
      if (cause instanceof BoundedResponseBodyLimitError) throw fail('Node response exceeds the Studio limit.');
      throw cause;
    }
    if (!response.ok) throw Object.assign(fail('nOS did not authorize or confirm the node operation.'), { status: response.status });
    const answer = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (answer.kind !== 'answer') throw fail('Node outcome is unconfirmed. Retain the invocation identity.');
    if (answer.status < 200 || answer.status >= 300)
      throw Object.assign(fail('The node did not confirm the operation.'), { status: answer.status });
    return answer.body;
  };
}

export async function invokeNosProgram(call, request) {
  const { selected, invocationId, inputs } = request;
  const ref = selected.program;
  const check = async () => {
    const approval = await call('programs/bindings', undefined, { contextGraphId: selected.contextGraphId, operationIri: selected.operationIri });
    if (approval.bindingDigest !== selected.bindingDigest || !approval.binding?.enabled || !isDeepStrictEqual(approval.binding.program, ref))
      throw fail('Program binding changed.');
  };
  await check();
  const source = await call('programs/source', undefined, { contextGraphId: ref.contextGraphId, programIri: ref.programIri, programLayer: ref.programLayer });
  if (typeof source.source !== 'string' || createHash('sha256').update(source.source).digest('hex') !== ref.sourceHash || source.version !== selected.version)
    throw fail('Program source changed.');
  const receipt = await call('programs/execute', { contextGraphId: selected.contextGraphId, operationIri: selected.operationIri, invocationId, inputs });
  if (receipt.persisted !== true || receipt.invocationId !== invocationId || receipt.executionIri !== 'urn:sr:execution:' + invocationId || !Array.isArray(receipt.outputs))
    throw fail('Program execution receipt is incomplete.');
  await check();
  return { invocationId, executionIri: receipt.executionIri, operationIri: selected.operationIri,
    sourceHash: ref.sourceHash, bindingDigest: selected.bindingDigest,
    outputs: receipt.outputs.map(output => { try { return JSON.parse(output); } catch { return output; } }) };
}

export async function writeNosEvidence(call, payload, graph) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(payload.name)) throw fail('Invalid evidence name.');
  const resource = (value, predicate = false) => {
    const parsed = typeof value === 'string' && parseWritableRdfTerm(value);
    if (!parsed || parsed.kind === 'literal' || predicate && parsed.kind !== 'iri') throw fail('Invalid evidence RDF resource.');
    return [parsed.kind, parsed.value];
  };
  // Compare decoded lexical values without discarding datatype or language.
  const term = value => {
    if (typeof value !== 'string') throw fail('Invalid evidence RDF term.');
    if (!value.startsWith('"')) return resource(value);
    const literal = parseRdfLiteralTerm(value, { combineSurrogatePairs: true });
    if (!literal) throw fail('Invalid evidence RDF literal.');
    if (literal.kind === 'language') return ['literal', { ...literal, language: literal.language.toLowerCase() }];
    return ['literal', canonicalizeRdfObjectTerm(value)];
  };
  const graphTerm = value => value === undefined || value === '' ? ['default'] : resource(value);
  const quads = rows => [...new Set(rows.map(q => JSON.stringify([
    resource(q.subject), resource(q.predicate, true), term(q.object), graphTerm(q.graph),
  ])))].sort();
  const expected = quads(payload.quads); // Reject malformed input before creation.
  const path = 'knowledge-assets/' + payload.name, query = { contextGraphId: graph };
  let metadata, created = false;
  try { metadata = await call(path, undefined, query); }
  catch (error) {
    if (error.status !== 404) throw error;
    if (!payload.allowCreate) throw fail('Previous write is unconfirmed; reconcile before creating another asset.');
    await call('knowledge-assets', { contextGraphId: graph, name: payload.name, quads: payload.quads,
      finalize: true, alsoShareSwm: false, alsoPublishVm: false });
    created = true;
  }
  const readback = await call(path + '/wm/quads', undefined, query);
  if (!Array.isArray(readback.quads) || !isDeepStrictEqual(quads(readback.quads), expected))
    throw fail('Stored evidence differs from this execution.');
  // The trusted profile owns its digest and RDF vocabulary. Exact readback binds
  // this storage receipt to the complete payload it supplied.
  metadata = await call(path, undefined, query);
  if (metadata.status !== 'wm-sealed') throw fail('Evidence has not been sealed.');
  return { contextGraphId: graph, name: payload.name, digest: payload.digest, metadata, created, readbackVerified: true };
}
