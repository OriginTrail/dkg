import type { BenchCase, Scene } from 'esbench';

type Hook = () => unknown | Promise<unknown>;

interface AsyncCaseHooks {
  beforeIteration?: Hook;
  afterIteration?: Hook;
}

type MutableBenchCase = BenchCase & {
  beforeHooks: Hook[];
  afterHooks: Hook[];
};

export function benchAsyncWithHooks(
  scene: Scene,
  name: string,
  fn: Hook,
  hooks: AsyncCaseHooks,
): void {
  const caseCount = scene.cases.length;
  scene.benchAsync(name, fn);

  if (scene.cases.length === caseCount) return;

  const benchCase = scene.cases[scene.cases.length - 1] as MutableBenchCase;
  benchCase.beforeHooks = [...benchCase.beforeHooks, ...optionalHook(hooks.beforeIteration)];
  benchCase.afterHooks = [...benchCase.afterHooks, ...optionalHook(hooks.afterIteration)];
}

function optionalHook(hook: Hook | undefined): Hook[] {
  return hook ? [hook] : [];
}
