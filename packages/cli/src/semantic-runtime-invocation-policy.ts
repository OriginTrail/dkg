import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { validateSemanticProgramPolicy } from './semantic-runtime-program-policy.js';
import { ConfiguredSemanticRuntimeService, SemanticProgramError, StoredSemanticProgram } from './semantic-runtime-types.js';
import { RDF_TYPE, SR, hashParts, iriValue, isOperatorVmGraph, literalValue, queryOptions, resultRows, sourceHashOf } from './semantic-runtime-values.js';
import { loadStoredSemanticProgram } from './semantic-runtime-program-source.js';

export function validateProgramPin(config: SemanticRuntimeConfig, program: StoredSemanticProgram, expectedSourceHash?: string): void {
  const policy = config.programPolicy!;
  validateSemanticProgramPolicy(policy);
  const pin = policy.programs.find(({ programIri }) => programIri === program.programIri);
  const actualHash = sourceHashOf(program);
  if (!policy.contextGraphIds.includes(program.contextGraphId) || !pin || pin.sourceHash !== actualHash
    || (expectedSourceHash !== undefined && expectedSourceHash !== actualHash)) {
    throw new SemanticProgramError('PROGRAM_NOT_PINNED', 'Program source or graph does not match the operator binding', 403);
  }
}

export async function assertProgramInvocationAuthorized(input: {
  agent: DKGAgent;
  runtime: ConfiguredSemanticRuntimeService;
  executionId: string;
  config: SemanticRuntimeConfig;
  contextGraphId: string;
  program: StoredSemanticProgram;
  originalCaller: string;
  operatorAddress: string;
  policyIri: string;
  policyHashHex: string;
}): Promise<void> {
  const { agent, runtime, executionId, config, contextGraphId, program, originalCaller, operatorAddress } = input;
  const assertActiveCapability = () => {
    const execution = runtime.store.execution(executionId);
    const capabilityId = executionId.replace('urn:sr:execution:', 'urn:sr:capability:');
    const capability = runtime.store.capability(capabilityId);
    const now = Date.now();
    if (!execution || execution.status !== 'active' || !capability
      || capability.executionId !== executionId || capability.revokedAt !== null
      || capability.policyEpoch !== execution.policyEpoch
      || now < capability.notBefore || now >= capability.expiresAt) {
      throw new SemanticProgramError('PROGRAM_AUTHORITY_REVOKED', 'Program invocation authority is no longer active', 403);
    }
  };
  assertActiveCapability();
  if (!await agent.canReadContextGraph(contextGraphId, { callerAgentAddress: originalCaller })) {
    throw new SemanticProgramError('PROGRAM_CALLER_ACCESS_DENIED', 'Original caller can no longer read the Context Graph', 403);
  }
  const currentProgram = await loadStoredSemanticProgram(
    agent, contextGraphId, program.programIri, program.layer, originalCaller,
  );
  validateProgramPin(config, currentProgram, sourceHashOf(program));
  if (currentProgram.authorAgentAddress !== program.authorAgentAddress
    || currentProgram.version !== program.version
    || JSON.stringify(currentProgram.requiredTools) !== JSON.stringify(program.requiredTools)
    || JSON.stringify(currentProgram.permittedPrograms) !== JSON.stringify(program.permittedPrograms)) {
    throw new SemanticProgramError('PROGRAM_DECLARATIONS_CHANGED', 'Program declarations changed during Program execution', 403);
  }
  const result = await agent.query(`
    SELECT DISTINCT ?g ?policyVersion ?tool WHERE {
      GRAPH ?g {
        ${sparqlIri(`did:dkg:agent:${operatorAddress}`)} <${SR}usesExecutionPolicy> ${sparqlIri(input.policyIri)} .
        ${sparqlIri(input.policyIri)} <${RDF_TYPE}> <${SR}ExecutionPolicy> ;
          <${SR}version> ?policyVersion ;
          <${SR}allowsTool> ?tool .
      }
    }
  `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-policy-recheck', originalCaller));
  const rows = resultRows(result).filter((row) => isOperatorVmGraph(row.g, contextGraphId, operatorAddress));
  const versions = new Set(rows.map((row) => literalValue(row.policyVersion)));
  const graphs = new Set(rows.map((row) => iriValue(row.g)));
  const tools = [...new Set(rows.map((row) => iriValue(row.tool)))].sort();
  const hash = hashParts([input.policyIri, `did:dkg:agent:${operatorAddress}`, [...versions][0] ?? '', ...tools]);
  if (rows.length === 0 || versions.size !== 1 || graphs.size !== 1 || hash !== input.policyHashHex) {
    throw new SemanticProgramError('PROGRAM_POLICY_CHANGED', 'Operator policy changed during Program execution', 403);
  }
  assertActiveCapability();
}
