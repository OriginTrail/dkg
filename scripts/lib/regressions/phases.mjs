// The replay phases of one side (historical or corrected) and the one rule for
// a phase that ran to completion. The runner that produces phase results and
// the validator that reads them back from a receipt both use this contract,
// so a live result and its serialized record are held to the same checks.

// Each prerequisite must succeed before the execution says anything.
export const PREREQUISITE_PHASES = Object.freeze(['pnpm-version', 'install', 'build', 'discovery']);
export const EXECUTION_PHASE = 'execution';
export const PHASE_ORDER = Object.freeze([...PREREQUISITE_PHASES, EXECUTION_PHASE]);

// A phase cut short, whatever its exit code says: a crash, a launch or output
// failure, a deadline, or a cancellation.
export const phaseInterrupted = (phase) => Boolean(phase.signal || phase.error || phase.timedOut || phase.cancelled);

// A prerequisite must also exit zero. The execution phase's exit code is each
// side's own expectation (the historical side fails, the corrected one passes),
// so only phaseInterrupted applies to it.
export const phaseSucceeded = (phase) => phase.code === 0 && !phaseInterrupted(phase);

const failure = (phase) => {
  if (phase.cancelled) return 'cancelled';
  if (phase.timedOut) return 'timed out';
  return phase.error ?? phase.signal ?? `exit ${phase.code}`;
};

export function requirePrerequisite(phase, name) {
  if (!PREREQUISITE_PHASES.includes(name)) throw new Error(`unknown prerequisite phase: ${name}`);
  if (!phaseSucceeded(phase)) throw new Error(`${name} failed; no behavioral proof (${failure(phase)})`);
}

// One side's recorded phases: exactly the contract's, in its order, every
// prerequisite successful. The execution is addressed by name.
export function sidePhases(phases, side) {
  const recorded = phases.filter((phase) => phase.side === side);
  if (recorded.map((phase) => phase.name).join(',') !== PHASE_ORDER.join(',')) throw new Error('missing successful prerequisites');
  const prerequisites = recorded.filter((phase) => PREREQUISITE_PHASES.includes(phase.name));
  if (!prerequisites.every(phaseSucceeded)) throw new Error('missing successful prerequisites');
  return { prerequisites, execution: recorded.find((phase) => phase.name === EXECUTION_PHASE) };
}
