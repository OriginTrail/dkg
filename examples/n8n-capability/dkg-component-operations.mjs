import { isDeepStrictEqual } from 'node:util';
import { programRequest, programResult } from './dkg-program.mjs';
import { requireDkgOperation } from './dkg-profile.mjs';

export const componentFailure = message => Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
const fail = componentFailure;

/** Pure preparation and interpretation; the call journal owns persistence and recovery. */
export function dkgComponentOperations({ profile }) {
  return {
    'dkg-read': {
      legacyResponse: ({ rows, node, prior }) => ({ items: requireDkgOperation(profile, 'dkg-read').readItems(rows, prior.result, node) }),
      prepare: ({ rows, node, input }) => requireDkgOperation(profile, 'dkg-read').readRequest(node, rows, input),
      execute: async ({ rows, node, actor, dispatch }, request) => {
        const read = requireDkgOperation(profile, 'dkg-read');
        const result = await dispatch(request, 'read', { actor });
        const items = read.readItems(rows, result, node);
        if (JSON.stringify(items).length > 8192) throw fail('DKG Read result exceeds the workflow batch limit.');
        return { result, response: { items } };
      },
    },
    'invoke-dkg-program': {
      legacyResponse: ({ prior }) => ({ items: prior.result.items }),
      prepare: ({ node, rows, id }) => programRequest(node, rows, id, profile),
      execute: async ({ actor, dispatch }, request) => {
        const result = programResult(await dispatch(request, 'invoke', { actor }), request);
        return { result, response: { items: result.items } };
      },
    },
    'dkg-write': {
      legacyResponse: () => { throw fail('The completed legacy write has no saved receipt; operator reconciliation is required.'); },
      prepare: ({ node, rows, id, input, value, workflow, completedResult }, reconcile) => {
        if (reconcile) throw Object.assign(fail('The legacy write has no saved request; operator reconciliation is required.'),
          { code: 'DKG_WRITE_PENDING', invocationId: id });
        const write = requireDkgOperation(profile, 'dkg-write');
        const definition = workflow.definition;
        const readNode = definition.nodes.find(
          (n) => n.componentId === "dkg-read",
        );
        const read = completedResult(readNode.id);
        if (!read) throw fail('DKG Read has not completed in this execution.');
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
          const confirmed = completedResult(invoked.id);
          if (!confirmed || !isDeepStrictEqual(confirmed.items, rows)) throw fail('Program output differs from this execution.');
          programContext = { blockId: invoked.id, receipt: confirmed.items[0].programExecution, rawOutputs: confirmed.rawOutputs };
        }
        return write.evidence(rows, context, read, input, programContext);
      },
      execute: async ({ id, value, actor, dispatch }, evidence, { reconcile }) => {
        const write = requireDkgOperation(profile, 'dkg-write');
        const { payload, recordCount, summary = {} } = evidence;
        let result;
        try { result = await dispatch({ ...payload, allowCreate: !reconcile }, 'write', { actor }); }
        catch (error) {
          throw Object.assign(error, { status: error.status ?? 409, code: 'DKG_WRITE_PENDING', invocationId: id, n8nExecutionId: value.executionId });
        }
        if (
          result.contextGraphId !== write.targetGraph ||
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
              contextGraphId: write.targetGraph,
              name: result.name,
              assetId: result.metadata.reservedUal,
              layer: "wm",
              status: "wm-sealed",
              readbackVerified: true,
              digest: payload.digest,
              recordCount,
              executionIri: "urn:sr:execution:" + id,
              n8nExecutionId: value.executionId,
            },
          ],
        };
        return { result, response: receipt };
      },
    },
  };
}
