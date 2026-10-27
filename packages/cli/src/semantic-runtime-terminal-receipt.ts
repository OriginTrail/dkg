import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ExecutionReceiptJournal, SemanticRuntimeStore, TerminalExecutionReceipt } from '@origintrail-official/dkg-semantic-runtime';
import { loadExecutionOutputs, persistExecutionKnowledgeAsset } from './semantic-runtime-execution-persistence.js';
import { historyIsAtLayer } from './semantic-runtime-values.js';
import { type SemanticInvocationResult, SemanticProgramError } from './semantic-runtime-types.js';

/** Resume only terminal persistence, never the guest or protected effects. */
export async function recoverTerminalExecutionReceipt(
  agent: DKGAgent, store: SemanticRuntimeStore, journal: ExecutionReceiptJournal,
  expected: Omit<TerminalExecutionReceipt, 'quads' | 'outputs'>, invocationId: string,
  assertAuthorized: () => Promise<void>,
): Promise<SemanticInvocationResult> {
  const terminal = journal.terminal!;
  const executionIri = `urn:sr:execution:${invocationId}`;
  const completed = store.execution(executionIri)?.status === 'completed';
  if (completed && journal.progress.phase !== 'completed') {
    throw new SemanticProgramError('EXECUTION_PERSISTENCE_INCONSISTENT', 'Completed execution has unfinished receipt persistence', 409);
  }
  if (Object.entries(expected).some(([key, value]) => terminal[key as keyof typeof expected] !== value)) {
    throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'Terminal receipt belongs to different inputs or authority', 409);
  }
  await assertAuthorized();
  const history = await agent.assertion.history(terminal.contextGraphId, terminal.name, { agentAddress: terminal.agentAddress });
  if (completed && (!history || !historyIsAtLayer(history, terminal.layer)
    || history[({ wm: 'wmCurrentAssertion', swm: 'swmCurrentAssertion', vm: 'vmCurrentAssertion' } as const)[terminal.layer]] !== journal.progress.assertion)) {
    throw new SemanticProgramError('EXECUTION_PERSISTENCE_INCONSISTENT', 'Completed receipt is missing or changed', 409);
  }
  // Completed authority permits disclosure only; it cannot recreate a receipt
  // or advance its lifecycle, even if external persistence has disappeared.
  const evidence = completed ? { ual: history!.publishedUal } : await persistExecutionKnowledgeAsset(
    agent, terminal.contextGraphId, terminal.name, terminal.agentAddress,
    terminal.quads, history, terminal.layer, assertAuthorized, journal);
  const outputs = await loadExecutionOutputs(agent, terminal.contextGraphId, executionIri, terminal.layer, terminal.agentAddress);
  if (JSON.stringify(outputs) !== JSON.stringify(terminal.outputs)) {
    throw new SemanticProgramError('EXECUTION_OUTPUT_INCONSISTENT', 'Persisted outputs differ from the terminal receipt', 409);
  }
  await assertAuthorized();
  if (!completed) store.setExecutionStatus(executionIri, 'completed');
  return { invocationId, executionIri, executionLayer: terminal.layer,
    ...(evidence.ual ? { executionUal: evidence.ual } : {}), outputs: terminal.outputs, persisted: true };
}
