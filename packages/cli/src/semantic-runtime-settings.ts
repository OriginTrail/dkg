import { validateN8nConfig } from './semantic-runtime-n8n-contract.js';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { validateEffectiveProgramConfiguration } from './semantic-runtime-program-bindings.js';
import { validateSemanticProgramPolicy } from './semantic-runtime-program-policy.js';
import { validatePositiveInteger } from './semantic-runtime-values.js';

export function validateSemanticRuntimeConfig(config: SemanticRuntimeConfig): void {
  validateEffectiveProgramConfiguration(config.programBindings ?? [], config.programRoutes ?? []);
  validateSemanticRuntimeSettings(config);
}

export function validateSemanticRuntimeSettings(config: SemanticRuntimeConfig): void {
  if (config.n8n !== undefined) validateN8nConfig(config.n8n);
  if (config.n8nNative !== undefined) validateN8nConfig(config.n8nNative);
  if (config.programPolicy !== undefined) validateSemanticProgramPolicy(config.programPolicy);
  validatePositiveInteger(config.watchdogMs, 'semanticRuntime.watchdogMs', 60_000);
  validatePositiveInteger(config.startupTimeoutMs, 'semanticRuntime.startupTimeoutMs', 120_000);
  validatePositiveInteger(config.maxEvents, 'semanticRuntime.maxEvents', 100_000);
  validatePositiveInteger(
    config.maxActiveExecutions,
    'semanticRuntime.maxActiveExecutions',
    1_024,
  );
  validatePositiveInteger(
    config.maxOperationsPerExecution,
    'semanticRuntime.maxOperationsPerExecution',
    10_000_000,
  );
  if (config.partitionId !== undefined && !/^[0-9a-fA-F]{64}$/.test(config.partitionId)) {
    throw new Error('semanticRuntime.partitionId must be 64 hexadecimal characters');
  }
  if (config.operatorPolicyIri !== undefined) {
    try {
      sparqlIri(config.operatorPolicyIri);
    } catch {
      throw new Error('semanticRuntime.operatorPolicyIri must be an absolute IRI');
    }
  }
  if (config.maxAccumulator !== undefined) {
    let value: bigint;
    try {
      value = BigInt(config.maxAccumulator);
    } catch {
      throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
    }
    if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
    }
  }
}
