export interface DkgClientLike {
  query(sparql: string, contextGraphId?: string): Promise<{ result: unknown }>;
  publish(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>): Promise<{ kcId: string; status: string }>;
  createContextGraph(id: string, name: string, description?: string): Promise<{ created: string; uri: string }>;
  subscribe(contextGraphId: string): Promise<{ subscribed: string }>;
}

export interface Experiment {
  valBpb: number;
  peakVramMb: number;
  status: 'keep' | 'discard' | 'crash';
  description: string;
  commitHash?: string;
  codeDiff?: string;
  trainingSeconds?: number;
  totalTokensM?: number;
  numParamsM?: number;
  mfuPercent?: number;
  depth?: number;
  numSteps?: number;
  platform?: string;
  agentDid?: string;
  runTag?: string;
  parentExperiment?: string;
}

export interface ExperimentRecord extends Experiment {
  uri: string;
  timestamp: string;
}
