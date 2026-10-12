// SPDX-License-Identifier: Apache-2.0
import { sparqlIri } from '@origintrail-official/dkg-core';
import { LlmClient } from '@origintrail-official/dkg-node-ui';
import { bindingValue } from '../manifest.js';
import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES, validateRequiredContextGraphId,
  respondIfStoreUnavailable, respondIfContextGraphReadAuthorityUnavailable } from '../http-utils.js';
import { actorFromRequestContext, type RequestContext } from './context.js';
import { requireContextGraphReadAuthority } from './context-graph-read-authority.js';

  // POST /api/genui/render  { contextGraphId, entityUri, libraryPrompt }
  //
  // Streams OpenUI Lang deltas over Server-Sent Events. The UI registers
  // the component library client-side with @openuidev/react-lang and
  // passes its `library.prompt()` text up; the daemon does the heavy
  // lifting — resolving triples, reading the profile hint for the entity's
  // rdf:type, composing the messages, and piping LlmClient stream events.
export async function handleGenuiRender(ctx: RequestContext): Promise<void> {
  const { req, res, agent, config } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  const { contextGraphId, entityUri, libraryPrompt } = parsed;
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;
  if (typeof entityUri !== "string" || !entityUri.trim()) {
    return jsonResponse(res, 400, { error: 'Missing "entityUri"' });
  }
  if (typeof libraryPrompt !== "string" || !libraryPrompt.trim()) {
    return jsonResponse(res, 400, { error: 'Missing "libraryPrompt"' });
  }
  if (!(await requireContextGraphReadAuthority(ctx, contextGraphId))) return;
  const callerAgentAddress = actorFromRequestContext(ctx).authenticatedAgentAddress;
  if (!config.llm?.apiKey) {
    return jsonResponse(res, 503, {
      error: 'LLM not configured. Set an API key in Settings to enable GenUI.',
    });
  }

  // Fetch entity triples.
  // The entity's data lives in the sub-graph's named assertion graph, so
  // we must wrap the pattern in GRAPH ?g — otherwise we'd only see the
  // default graph, which is empty for these imports. DISTINCT because
  // promoted triples can appear under both WM and SWM/VM named graphs
  // for the same sub-graph.
  let triples: Array<{ p: string; o: string }> = [];
  let entityRdfType: string | null = null;
  try {
    // Stripping angle brackets is only ergonomic ("accept <uri> or uri"),
    // not sanitisation — a crafted input containing `>` or whitespace can
    // still break out of the interpolated `<…>`. `sparqlIri` runs
    // `assertSafeIri` before wrapping.
    const entityIri = entityUri.replace(/^<|>$/g, '');
    let safeEntityIri: string;
    try {
      safeEntityIri = sparqlIri(entityIri);
    } catch {
      return jsonResponse(res, 400, {
        error: `Unsafe entityUri: ${entityUri}`,
      });
    }
    const triplesResult = await agent.query(
      `SELECT DISTINCT ?p ?o WHERE { GRAPH ?g { ${safeEntityIri} ?p ?o } } LIMIT 200`,
      { contextGraphId, callerAgentAddress },
    );
    // `agent.query()` can return bindings as SPARQL-JSON objects
    // (`{value, type, …}`) once the result has passed through the
    // normaliser — stringifying them directly produces "[object Object]"
    // and wrecks the downstream rdf:type lookup / LLM prompt. See
    // `bindingValue` near the top of this file.
    triples = (triplesResult?.bindings ?? []).map((row: any) => ({
      p: bindingValue(row.p),
      o: bindingValue(row.o),
    }));
    const typeT = triples.find(
      (t) => t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    if (typeT) entityRdfType = typeT.o;
  } catch (err: any) {
    if (respondIfStoreUnavailable(res, err) !== null) return;
    // The scoped triple read goes through the same authority resolution as
    // `/api/query`; an unavailable source is retryable and its internal
    // source/reason must not be echoed back through the generic 500 message.
    if (respondIfContextGraphReadAuthorityUnavailable(res, err)) return;
    return jsonResponse(res, 500, {
      error: `Failed to fetch entity triples: ${err.message}`,
    });
  }

  if (triples.length === 0) {
    return jsonResponse(res, 404, {
      error: `No triples found for <${entityUri}> in ${contextGraphId}`,
    });
  }

  // Fetch the profile's detailHint for this type from the `meta` sub-graph.
  // Same GRAPH ?g reasoning as above — the profile lives in a named
  // assertion graph under `.../meta/assertion/...`, not in the default.
  let detailHint: string | null = null;
  let entityTypeLabel: string | null = null;
  if (entityRdfType) {
    // `entityRdfType` came from the quadstore as the value of `rdf:type`,
    // so it's normally a safe IRI — but crafted imported data could in
    // principle smuggle unsafe chars through. Validate before interpolating.
    let safeTypeIri: string | null = null;
    try {
      safeTypeIri = sparqlIri(entityRdfType);
    } catch {
      safeTypeIri = null;
    }
    if (safeTypeIri) {
      try {
        const hintResult = await agent.query(
          `
            SELECT ?hint ?label WHERE {
              GRAPH ?g {
                ?binding <http://dkg.io/ontology/profile/forType> ${safeTypeIri} ;
                         <http://dkg.io/ontology/profile/detailHint> ?hint .
                OPTIONAL { ?binding <http://dkg.io/ontology/profile/label> ?label }
              }
            } LIMIT 1
          `,
          { contextGraphId, subGraphName: 'meta', callerAgentAddress },
        );
        const row = hintResult?.bindings?.[0];
        if (row) {
          const hintRaw = bindingValue(row.hint);
          detailHint = hintRaw.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
          if (row.label) {
            const labelRaw = bindingValue(row.label);
            entityTypeLabel = labelRaw.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
          }
        }
      } catch {
        // meta sub-graph may be missing — fall through, LLM still has triples.
      }
    }
  }

  // Compose the prompt
  const systemPrompt =
    libraryPrompt +
    `\n\n# Task\n` +
    `You will be given an RDF entity from a DKG context graph, described by its triples (predicate -> object). ` +
    `Compose a single OpenUI Lang response that renders a rich, domain-appropriate detail view of this entity ` +
    `using only components from the library above.\n` +
    `\n## Rules\n` +
    `- Output OpenUI Lang only. No prose, no markdown fences, no commentary.\n` +
    `- Use the EntityDetail root if the library declares one; otherwise start with whatever the library's root wants.\n` +
    `- Extract display values from the literal objects (strip XSD datatype suffixes).\n` +
    `- If URI objects look like "urn:dkg:...", treat them as links to other entities.\n` +
    `- Prefer grouping: header card -> stats grid -> related lists.\n` +
    `- Keep it compact — no more than ~12 child blocks.\n`;

  const userMessage = [
    `Entity URI: ${entityUri}`,
    entityRdfType ? `rdf:type: ${entityRdfType}${entityTypeLabel ? ` (${entityTypeLabel})` : ''}` : '',
    detailHint ? `\nProfile hint for this type:\n${detailHint}` : '',
    `\nTriples (${triples.length}):\n` + triples.slice(0, 120).map(t => `  ${t.p}  ${t.o}`).join('\n'),
    triples.length > 120 ? `  … (${triples.length - 120} more triples truncated)` : '',
  ].filter(Boolean).join('\n');

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const client = new LlmClient();
  const sendEvent = (type: string, data: unknown) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('start', { entityUri, entityRdfType, entityTypeLabel });
  try {
    const events = client.stream({
      config: config.llm!,
      request: {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: true,
        temperature: 0.3,
        maxTokens: 1500,
      },
    });
    for await (const ev of events) {
      if (ev.type === 'text_delta') {
        sendEvent('delta', { text: ev.delta });
      } else if (ev.type === 'final') {
        sendEvent('final', { content: ev.message.content ?? '' });
      } else if (ev.type === 'error') {
        sendEvent('error', { error: ev.error });
      }
    }
    sendEvent('done', {});
  } catch (err: any) {
    sendEvent('error', { error: err?.message ?? String(err) });
  } finally {
    res.end();
  }
}
