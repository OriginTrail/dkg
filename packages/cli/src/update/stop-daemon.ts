import {
  daemonShutdownCoordinator,
  reportDaemonShutdownResult,
  type DaemonShutdownCoordinator,
} from '../daemon/shutdown-wait.js';

interface StopDaemonDependencies {
  coordinator: DaemonShutdownCoordinator;
  log(message: string): void;
  error(message: string): void;
}

const defaultStopDaemonDependencies: StopDaemonDependencies = {
  coordinator: daemonShutdownCoordinator,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** Returns true if the daemon stopped (or was not running). */
export async function stopDaemonIfRunning(
  dependencies: StopDaemonDependencies = defaultStopDaemonDependencies,
): Promise<boolean> {
  const result = await dependencies.coordinator.stopViaSignal();
  return reportDaemonShutdownResult(result, dependencies);
}
