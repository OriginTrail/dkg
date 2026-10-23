import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ExecutionReceiptJournal, SemanticRuntimeStore, TerminalExecutionReceipt } from '@origintrail-official/dkg-semantic-runtime';
import { loadExecutionOutputs, persistExecutionKnowledgeAsset } from './semantic-runtime-execution-persistence.js';
import { type SemanticInvocationResult, SemanticProgramError } from './semantic-runtime-types.js';

/** Resume only terminal persistence, never the guest or protected effects. */
export async function recoverTerminalExecutionReceipt(
  agent: DKGAgent, store: SemanticRuntimeStore, journal: ExecutionReceiptJournal,
  expected: Omit<TerminalExecutionReceipt, 'quads' | 'outputs'>, invocationId: string,
  assertAuthorized: () => Promise<void>,
): Promise<SemanticInvocationResult> {
  const terminal = journal.terminal!;
  if (Object.entries(expected).some(([key, value]) => terminal[key as keyof typeof expected] !== value)) {
    throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'Terminal receipt belongs to different inputs or authority', 409);
  }
  await assertAuthorized();
  const history = await agent.assertion.history(terminal.contextGraphId, terminal.name, { agentAddress: terminal.agentAddress });
  const evidence = await persistExecutionKnowledgeAsset(agent, terminal.contextGraphId, terminal.name,
    terminal.agentAddress, terminal.quads, history, terminal.layer, assertAuthorized, journal);
  const executionIri = `urn:sr:execution:${invocationId}`;
  const outputs = await loadExecutionOutputs(agent, terminal.contextGraphId, executionIri, terminal.layer, terminal.agentAddress);
  if (JSON.stringify(outputs) !== JSON.stringify(terminal.outputs)) {
    throw new SemanticProgramError('EXECUTION_OUTPUT_INCONSISTENT', 'Persisted outputs differ from the terminal receipt', 409);
  }
  await assertAuthorized();
  store.setExecutionStatus(executionIri, 'completed');
  return { invocationId, executionIri, executionLayer: terminal.layer,
    ...(evidence.ual ? { executionUal: evidence.ual } : {}), outputs: terminal.outputs, persisted: true };
}
