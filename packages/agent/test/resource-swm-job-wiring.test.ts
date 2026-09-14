import { expect, it, vi } from 'vitest';
import { projectStartupResourceDiagnostics } from '../src/resource-policy.js';
import {
  callSelectedSharedMemorySummary,
  createSelectedSwmLifecycleHarness,
  snapshotManifest,
} from './selected-swm-test-helpers.js';

it.each([
  { name: 'disabled job budget', startupBudget: '60000', startupPasses: '4', budget: '0', passes: '4', calls: 1 },
  { name: 'single job pass', startupBudget: '60000', startupPasses: '4', budget: '60000', passes: '1', calls: 1 },
  { name: 'enabled job continuation', startupBudget: '0', startupPasses: '1', budget: '60000', passes: '2', calls: 2 },
])('refreshes selected SWM settings after construction: $name', async (setting) => {
  vi.stubEnv('DKG_SWM_CATCHUP_PASS_BUDGET_MS', setting.startupBudget);
  vi.stubEnv('DKG_SWM_CATCHUP_MAX_PASSES', setting.startupPasses);
  const contextGraphId = 'selected-job-environment';
  const manifest = snapshotManifest(contextGraphId, 2);
  const prefix = manifest.meta.slice(0, 3);
  const harness = createSelectedSwmLifecycleHarness({
    contextGraphs: { public: contextGraphId }, manifest,
    clock: { now: () => 1_000, deadline: () => 1_001 },
    metaPages: [
      { quads: prefix, resumedFromOffset: 0, nextOffset: prefix.length, completed: false, timedOut: true },
      { quads: manifest.meta.slice(3), resumedFromOffset: 3, nextOffset: manifest.meta.length, completed: true, timedOut: false },
    ],
  });
  try {
    const policy = harness.agent.config.resourcePolicy;
    expect(policy.initialSwmPass).toEqual({ budgetMs: Number(setting.startupBudget), maxPasses: Number(setting.startupPasses) });
    const priorities = { elevated: 0, default: 0, deprioritized: 0 };
    const diagnostic = projectStartupResourceDiagnostics(policy, priorities);
    vi.stubEnv('DKG_SWM_CATCHUP_PASS_BUDGET_MS', setting.budget);
    vi.stubEnv('DKG_SWM_CATCHUP_MAX_PASSES', setting.passes);
    const summary = await callSelectedSharedMemorySummary(harness.agent, [contextGraphId], {
      selectedSwmPriority: true,
      recoveryTargets: [{ contextGraphId, lane: 'selected-public' }],
    });
    expect(summary.continuationPasses).toBe(setting.calls - 1);
    expect(harness.probes.metaRequesterScopes).toHaveLength(setting.calls);
    expect(projectStartupResourceDiagnostics(policy, priorities)).toEqual(diagnostic);
    if (setting.calls === 2) expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
  } finally {
    await harness.close();
    vi.unstubAllEnvs();
  }
});
