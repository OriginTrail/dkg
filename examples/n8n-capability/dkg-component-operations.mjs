import { isDeepStrictEqual } from 'node:util';
import { programRequest, programResult } from './dkg-program.mjs';

export const componentFailure = message => Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
const fail = componentFailure;

/** Prepare synchronously inside the pending-call transaction; dispatch only after it commits. */
export function dkgComponentOperations({ db, profile, transport, assertNoPendingWrite }) {
  return {
    'dkg-read': {
      legacyResponse: ({ rows, node, prior }) => ({ items: profile.readItems(rows, JSON.parse(prior.result), node) }),
      prepare: ({ rows, node, input, actor }) => async () => {
        const result = await transport(profile.readRequest(node, rows, input), 'read', { actor });
        const items = profile.readItems(rows, result, node);
        if (JSON.stringify(items).length > 8192) throw fail('DKG Read result exceeds the workflow batch limit.');
        return { result, response: { items } };
      },
    },
    'invoke-dkg-program': {
      legacyResponse: ({ prior }) => ({ items: JSON.parse(prior.result).items }),
      prepare: ({ node, rows, id, actor }) => {
        const request = programRequest(node, rows, id, profile);
        return async () => {
          const result = programResult(await transport(request, 'invoke', { actor }), request);
          return { result, response: { items: result.items } };
        };
      },
    },
    'dkg-write': {
      legacyResponse: ({ key }) => {
        const saved = db.prepare('SELECT receipt FROM dkg_component_writes WHERE id=?').get(key);
        if (!saved?.receipt) throw fail('The completed legacy write has no saved receipt; operator reconciliation is required.');
        return JSON.parse(saved.receipt);
      },
      prepare: ({ node, rows, id, key, input, value, workflow, actor, prior }) => {
        const definition = workflow.definition;
        const readNode = definition.nodes.find(
          (n) => n.componentId === "dkg-read",
        );
        const read = db
          .prepare("SELECT result FROM dkg_component_calls WHERE id=?")
          .get(id + ":" + readNode.id);
        if (!read?.result)
          throw fail("DKG Read has not completed in this execution.");
        const context = {
          kaRef: workflow.kaRef,
          sourceHash: workflow.sourceHash,
          invocationId: id,
          executionIri: "urn:sr:execution:" + id,
          n8nExecutionId: value.executionId,
          blockId: node.id,
        };
        // The pinned upstream block selects provenance; record fields are only data.
        const incoming = definition.edges.find(e => e.to === node.id);
        const invoked = definition.nodes.find(n => n.id === incoming?.from && n.componentId === 'invoke-dkg-program');
        let programContext;
        if (invoked) {
          const completed = db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':' + invoked.id);
          const confirmed = completed?.result && JSON.parse(completed.result);
          if (!confirmed || !isDeepStrictEqual(confirmed.items, rows)) throw fail('Program output differs from this execution.');
          programContext = { blockId: invoked.id, receipt: confirmed.items[0].programExecution, rawOutputs: confirmed.rawOutputs };
        }
        const savedWrite = db.prepare('SELECT * FROM dkg_component_writes WHERE id=?').get(key);
        const evidence = savedWrite ? JSON.parse(savedWrite.evidence)
          : profile.evidence(rows, context, JSON.parse(read.result), input, programContext);
        const { payload, recordCount, summary = {} } = evidence;
        if (!prior) assertNoPendingWrite(workflow, id);
        // Persist the exact callback AND write payload before the first possible effect.
        // A new profile evaluation or a new native run must never stand in for this request.
        db.prepare('INSERT OR IGNORE INTO dkg_component_writes VALUES (?,?,?,NULL)').run(key, JSON.stringify(value), JSON.stringify(evidence));
        return async () => {
          let result;
          try { result = await transport({ ...payload, allowCreate: !prior }, 'write', { actor }); }
          catch (error) {
            throw Object.assign(error, { status: error.status ?? 409, code: 'DKG_WRITE_PENDING', invocationId: id, n8nExecutionId: value.executionId });
          }
          if (
            result.contextGraphId !== profile.targetGraph ||
            result.digest !== payload.digest ||
            result.name !== payload.name ||
            result.readbackVerified !== true ||
            result.metadata?.status !== "wm-sealed"
          )
            throw Object.assign(fail("DKG write readback did not confirm this exact evidence."),
              { code: 'DKG_WRITE_PENDING', invocationId: id, n8nExecutionId: value.executionId });
          if (profile.requiresNosActor) await profile.authorize(actor);
          const receipt = {
            items: [
              {
                ...summary,
                node: profile.node,
                contextGraphId: profile.targetGraph,
                name: result.name,
                assetId: result.metadata.reservedUal,
                layer: "wm",
                status: "wm-sealed",
                readbackVerified: true,
                digest: payload.digest,
                recordCount,
                executionIri: context.executionIri,
                n8nExecutionId: value.executionId,
              },
            ],
          };
          return { result, response: receipt };
        };
      },
    },
  };
}
