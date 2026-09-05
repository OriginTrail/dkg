// SPDX-License-Identifier: Apache-2.0

/**
 * CCL (composable consent layer) policy subsystem extracted from dkg-agent.ts
 * as a mixin holder: policy publish/approve/revoke, policy + binding listing,
 * policy/fact resolution and policy evaluation (incl. evaluate-and-publish).
 * 1:1 move; methods take `this: DKGAgent` so cross-calls resolve against the
 * composed class.
 */

import {
  contextGraphDataGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
  DKG_ONTOLOGY,
  createOperationContext,
  sparqlString,
} from '@origintrail-official/dkg-core';

import { type PublishResult } from '@origintrail-official/dkg-publisher';

// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
// type alias so listPendingJoinApprovalRetries() retains its old
// public shape while it stubs out to []. PR-12 rebuilds the operator
// diagnostic surface on top of the substrate outbox and will return
// real entries with substrate-shaped metadata.
type JoinApprovalRetryEntry = {
  contextGraphId: string;
  agentAddress: string;
  attempts: number;
  firstFailureAt: number;
  nextAttemptAt: number;
  lastError: string;
};

import {
  buildCclPolicyQuads,
  buildPolicyApprovalQuads,
  buildPolicyRevocationQuads,
  CclResourceNotFoundError,
  hashCclPolicy,
  type CclPolicyRecord,
} from './ccl-policy.js';
import {
  CclEvaluator,
  parseCclPolicy,
  validateCclPolicy,
  type CclEvaluationResult,
  type CclFactTuple,
} from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import { stripLiteral } from './dkg-agent-utils.js';

import { type CclPublishedEvaluationRecord } from './dkg-agent-types.js';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

export class CclPolicyMethods extends DKGAgentBase {
  async publishCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.contextGraphId))) {
      throw new Error(`Context Graph "${opts.contextGraphId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ contextGraphId: opts.contextGraphId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.contextGraphId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for contextGraph "${opts.contextGraphId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) {
      throw new CclResourceNotFoundError(
        'policy',
        `CCL policy not found: ${opts.policyUri}`,
      );
    }
    if (record.contextGraphId !== opts.contextGraphId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to contextGraph "${record.contextGraphId}", not "${opts.contextGraphId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    // Emit the public `dkg:creator` peer DID as the binding owner: it's the
    // handle remote peers resolve via ONTOLOGY gossip, so gossip-publish-handler
    // will accept the approval. `_meta`-only `dkg:curator` (wallet DID) is
    // used for local authorization via `assertContextGraphOwner` above.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      policyName: record.name,
      creator: ownerDid,
      graph: ontologyGraph,
      approvedAt,
      contextType: effectiveContextType,
    });

    quads.push(
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('approved'), graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: ownerDid, graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(approvedAt), graph: ontologyGraph },
    );

    await this.store.insert(quads);
    await this.publishOntologyQuads(bindingUri, quads);
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for contextGraph "${opts.contextGraphId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);

    const target = await this.getActiveCclPolicyBinding({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new CclResourceNotFoundError(
        'policy_binding',
        `No active CCL policy binding found for ${opts.policyUri} in contextGraph "${opts.contextGraphId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`,
      );
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    // See note in approveCclPolicy — use `dkg:creator` (peer DID) for the
    // public binding metadata so it round-trips through ONTOLOGY gossip.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: ownerDid,
      graph: ontologyGraph,
      revokedAt,
      contextGraphUri: `did:dkg:context-graph:${opts.contextGraphId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for contextGraph "${opts.contextGraphId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(this: DKGAgent, opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?contextGraph ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                  <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                  <${DKG_ONTOLOGY.DKG_POLICY_VERSION}> ?version ;
                  <${DKG_ONTOLOGY.DKG_POLICY_HASH}> ?hash ;
                  <${DKG_ONTOLOGY.DKG_POLICY_LANGUAGE}> ?language ;
                  <${DKG_ONTOLOGY.DKG_POLICY_FORMAT}> ?format ;
                  <${DKG_ONTOLOGY.DKG_POLICY_STATUS}> ?status .
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${bodyClause}
          ${filterBlock}
        }
      }
      ORDER BY ?name ?version
    `);

    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const contextGraphUri = row['contextGraph'];
        const contextGraphId = contextGraphUri.startsWith('did:dkg:context-graph:') ? contextGraphUri.slice('did:dkg:context-graph:'.length) : contextGraphUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${contextGraphId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.contextGraphId === contextGraphId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          contextGraphId,
          name,
          version: stripLiteral(row['version']),
          hash: stripLiteral(row['hash']),
          language: stripLiteral(row['language']),
          format: stripLiteral(row['format']),
          status: this.deriveCclPolicyStatus(row['policy'], stripLiteral(row['status']), bindings, latestByScope),
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          approvedBy: row['approvedBy'],
          approvedAt: row['approvedAt'] ? stripLiteral(row['approvedAt']) : undefined,
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          body: row['body'] ? stripLiteral(row['body']) : undefined,
          isActiveDefault: defaultActive?.policyUri === row['policy'],
          activeContexts,
        };

        const current = records.get(row['policy']);
        if (!current || (current.status !== 'approved' && nextRecord.status === 'approved')) {
          records.set(row['policy'], nextRecord);
        }
      }
    }

    return Array.from(records.values())
      .filter(record => !opts.status || record.status === opts.status)
      .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }

  async resolveCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(this: DKGAgent, opts: {
    contextGraphId: string;
    snapshotId?: string;
    view?: string;
    scopeUal?: string;
    policyName?: string;
    contextType?: string;
  }): Promise<{
    facts: CclFactTuple[];
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'snapshot-resolved';
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: CclFactResolutionMode;
    result: CclEvaluationResult;
  }> {
    const policy = await this.resolveCclPolicy({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy) {
      throw new CclResourceNotFoundError(
        'approved_policy',
        `No approved policy found for ${opts.contextGraphId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`,
      );
    }
    if (!policy.body) {
      throw new Error(`CCL policy body missing: ${policy.policyUri}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          contextGraphId: opts.contextGraphId,
          snapshotId: opts.snapshotId,
          view: opts.view,
          scopeUal: opts.scopeUal,
          policyName: policy.name,
          contextType: opts.contextType ?? policy.contextType,
        });
    const evaluator = new CclEvaluator(parsed, factInput.facts);
    const result = evaluator.run();

    return {
      policy: {
        policyUri: policy.policyUri,
        contextGraphId: policy.contextGraphId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        contextGraphId: opts.contextGraphId,
        contextType: opts.contextType,
        view: opts.view,
        snapshotId: opts.snapshotId,
        scopeUal: opts.scopeUal,
      },
      factSetHash: factInput.factSetHash,
      factQueryHash: factInput.factQueryHash,
      factResolverVersion: factInput.factResolverVersion,
      factResolutionMode: factInput.factResolutionMode,
      result,
    };
  }

  async evaluateAndPublishCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    evaluationUri: string;
    publish: PublishResult;
    evaluation: {
      policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        contextGraphId: string;
        contextType?: string;
        view?: string;
        snapshotId?: string;
        scopeUal?: string;
      };
      factSetHash: string;
      factQueryHash: string;
      factResolverVersion: string;
      factResolutionMode: CclFactResolutionMode;
      result: CclEvaluationResult;
    };
  }> {
    const evaluation = await this.evaluateCclPolicy(opts);
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: evaluation.policy.policyUri,
      factSetHash: evaluation.factSetHash,
      factQueryHash: evaluation.factQueryHash,
      factResolverVersion: evaluation.factResolverVersion,
      factResolutionMode: evaluation.factResolutionMode,
      result: evaluation.result,
      evaluatedAt: new Date().toISOString(),
      view: evaluation.context.view,
      snapshotId: evaluation.context.snapshotId,
      scopeUal: evaluation.context.scopeUal,
      contextType: evaluation.context.contextType,
    }, graph);
    const publish = await this.publish(opts.contextGraphId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const filters: string[] = [];
    if (opts.policyUri) filters.push(`?policy = <${opts.policyUri}>`);
    if (opts.snapshotId) filters.push(`?snapshotId = ${sparqlString(opts.snapshotId)}`);
    if (opts.view) filters.push(`?view = ${sparqlString(opts.view)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    if (opts.resultKind) filters.push(`?kind = ${sparqlString(opts.resultKind)}`);
    if (opts.resultName) filters.push(`?resultName = ${sparqlString(opts.resultName)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';

    const result = await this.store.query(`
      SELECT ?evaluation ?policy ?factSetHash ?factQueryHash ?factResolverVersion ?factResolutionMode ?createdAt ?view ?snapshotId ?scopeUal ?contextType ?entry ?kind ?resultName ?arg ?argIndex ?argValue WHERE {
        GRAPH <${graph}> {
          ?evaluation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_EVALUATION}> ;
                      <${DKG_ONTOLOGY.DKG_EVALUATED_POLICY}> ?policy ;
                      <${DKG_ONTOLOGY.DKG_FACT_SET_HASH}> ?factSetHash .
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_QUERY_HASH}> ?factQueryHash }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION}> ?factResolverVersion }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE}> ?factResolutionMode }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?createdAt }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          OPTIONAL {
            ?evaluation <${DKG_ONTOLOGY.DKG_HAS_RESULT}> ?entry .
            ?entry <${DKG_ONTOLOGY.DKG_RESULT_KIND}> ?kind ;
                   <${DKG_ONTOLOGY.DKG_RESULT_NAME}> ?resultName .
            OPTIONAL {
              ?entry <${DKG_ONTOLOGY.DKG_HAS_RESULT_ARG}> ?arg .
              ?arg <${DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX}> ?argIndex ;
                   <${DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE}> ?argValue .
            }
          }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?createdAt) ?evaluation ?kind ?resultName ?argIndex
    `);

    if (result.type !== 'bindings') return [];
    const records = new Map<string, CclPublishedEvaluationRecord>();
    const entryArgs = new Map<string, Map<number, unknown>>();
    for (const row of result.bindings as Record<string, string>[]) {
      const evaluationUri = row['evaluation'];
      let record = records.get(evaluationUri);
      if (!record) {
        record = {
          evaluationUri,
          policyUri: row['policy'],
          factSetHash: stripLiteral(row['factSetHash']),
          factQueryHash: row['factQueryHash'] ? stripLiteral(row['factQueryHash']) : undefined,
          factResolverVersion: row['factResolverVersion'] ? stripLiteral(row['factResolverVersion']) : undefined,
          factResolutionMode: row['factResolutionMode'] ? stripLiteral(row['factResolutionMode']) as CclFactResolutionMode : undefined,
          createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
          view: row['view'] ? stripLiteral(row['view']) : undefined,
          snapshotId: row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined,
          scopeUal: row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          results: [],
        };
        records.set(evaluationUri, record);
      }

      if (row['entry']) {
        const entryUri = row['entry'];
        let existing = record.results.find(resultEntry => resultEntry.entryUri === entryUri);
        if (!existing) {
          existing = {
            entryUri,
            kind: stripLiteral(row['kind']) as 'derived' | 'decision',
            name: stripLiteral(row['resultName']),
            tuple: [],
          };
          record.results.push(existing);
        }

        if (row['arg'] && row['argIndex'] && row['argValue']) {
          let args = entryArgs.get(entryUri);
          if (!args) {
            args = new Map<number, unknown>();
            entryArgs.set(entryUri, args);
          }
          args.set(Number(stripLiteral(row['argIndex'])), JSON.parse(stripLiteral(row['argValue'])));
        }
      }
    }

    for (const record of records.values()) {
      for (const resultEntry of record.results) {
        const args = entryArgs.get(resultEntry.entryUri);
        if (args && args.size > 0) {
          resultEntry.tuple = [...args.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
        }
      }
    }

    return Array.from(records.values());
  }

}
