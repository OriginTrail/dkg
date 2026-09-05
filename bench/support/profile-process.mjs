import { spawn } from 'node:child_process';

export function createProfileEnvironment(baseEnv, {
  reportJsonPath,
  reportHtmlPath,
} = {}) {
  return {
    ...baseEnv,
    DKG_ESBENCH_IN_PROCESS: '1',
    ESBENCH_HTML: baseEnv.ESBENCH_HTML ?? '1',
    ESBENCH_RESULT: baseEnv.ESBENCH_RESULT ?? reportJsonPath,
    ESBENCH_HTML_FILE: baseEnv.ESBENCH_HTML_FILE ?? reportHtmlPath,
  };
}

export function runProfileProcess(args, env, {
  cwd,
  executable = process.execPath,
  spawnProcess = spawn,
  reportError = (error) => console.error(error),
} = {}) {
  return new Promise((resolveExitCode) => {
    const child = spawnProcess(executable, args, {
      cwd,
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      reportError(error);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        reportError(`[bench:profile] profiler run exited from signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}
