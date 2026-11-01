import type { HardenExecutablePhase } from '../src/daemon/harden/steps.js';
import type { HardenExecutionDependencies, HardenWorkflowInputs } from '../src/daemon/harden/actions.js';
function boundExecution(phase: HardenExecutablePhase, dependencies: HardenExecutionDependencies, context: HardenWorkflowInputs) {
  void phase.execute();
  // @ts-expect-error bound phases accept no independently supplied action context
  void phase.execute(context);
  // @ts-expect-error execution services cannot supply target container or path identity
  const foreignDependencies: HardenExecutionDependencies = { ...dependencies, containerName: 'foreign' };
  // @ts-expect-error the captured specification cannot be reassigned
  context.specification = { ...context.specification, exportPath: '/foreign/bigdata.jnl' };
  // @ts-expect-error target fields cannot be changed through the captured specification
  context.specification.volumeAttemptId = 'foreign';
  void foreignDependencies;
}
void boundExecution;
