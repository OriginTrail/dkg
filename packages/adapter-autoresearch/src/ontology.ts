/**
 * RDF ontology for autonomous ML research experiments.
 *
 * Namespace: https://ontology.dkg.io/autoresearch#
 *
 * An Experiment is a single training run (5-minute budget) where an agent
 * modifies code, trains, evaluates, and records the outcome. Experiments
 * form a linked chain via parentExperiment, enabling agents across the
 * network to build on each other's findings.
 */

export const NS = 'https://ontology.dkg.io/autoresearch#';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const Class = {
  Experiment: `${NS}Experiment`,
  AgentRun: `${NS}AgentRun`,
} as const;

export const Prop = {
  // Experiment identity
  valBpb: `${NS}valBpb`,
  peakVramMb: `${NS}peakVramMb`,
  status: `${NS}status`,
  description: `${NS}description`,
  commitHash: `${NS}commitHash`,
  codeDiff: `${NS}codeDiff`,

  // Training metrics
  trainingSeconds: `${NS}trainingSeconds`,
  totalTokensM: `${NS}totalTokensM`,
  numParamsM: `${NS}numParamsM`,
  mfuPercent: `${NS}mfuPercent`,
  depth: `${NS}depth`,
  numSteps: `${NS}numSteps`,

  // Provenance
  platform: `${NS}platform`,
  agentDid: `${NS}agentDid`,
  runTag: `${NS}runTag`,
  timestamp: `${NS}timestamp`,
  parentExperiment: `${NS}parentExperiment`,

  // AgentRun (groups experiments by session)
  startedAt: `${NS}startedAt`,
  experimentCount: `${NS}experimentCount`,
  bestValBpb: `${NS}bestValBpb`,
  hasExperiment: `${NS}hasExperiment`,
} as const;

export const Status = {
  Keep: `${NS}keep`,
  Discard: `${NS}discard`,
  Crash: `${NS}crash`,
} as const;

export const DEFAULT_CONTEXT_GRAPH = 'autoresearch';
