import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_GRAPH_CATALOG_MAX_BYTES_ENV } from '../src/index.js';
import { createGraphCatalogSizeRecorder } from '../src/graph-catalog-metrics.js';
import { GRAPH_CATALOG_WARNING_REPEAT_MS, createGraphCatalogOverLimitWarning } from '../src/graph-catalog-internal-limit.js';
// The observability alert specs, built as tools/observability/generate-observability.mjs builds them.
import { buildAlerts } from '../../../tools/observability/lib/alerts.mjs';
import { promNodeProfile } from '../../../tools/observability/lib/profile.mjs';

afterEach(() => vi.unstubAllEnvs());

/** The rule on the 80 % warning, its one line filter, and the range it counts lines over. */
function catalogRule() {
  const { specs } = buildAlerts({ nodeProfile: promNodeProfile('instance'), VM_UID: 'vm', LOKI_UID: 'loki' });
  const rule = specs.find((spec: { title: string }) => spec.title.startsWith('Graph catalog at 80%'));
  expect(rule?.expr).toContain('severity_text=`WARN`');
  const lineFilters = [...String(rule?.expr).matchAll(/\|= `([^`]*)`/g)].map(match => match[1]!);
  expect(lineFilters).toHaveLength(1);
  const range = /count_over_time\(.*\[(\d+)m\]\)/.exec(String(rule?.expr));
  expect(range).not.toBeNull();
  return { lineFilters, rangeMs: Number(range![1]) * 60_000 };
}

describe('the graph catalog alert and the warning it reads', () => {
  it('matches the 80 % warning the recorder logs, and neither the 50 % warning nor another one', () => {
    const { lineFilters } = catalogRule();

    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '1000');
    const warnings: string[] = [];
    const record = createGraphCatalogSizeRecorder({ warn: message => { warnings.push(message); } });
    record({ graphs: 1, bytes: 500 });
    record({ graphs: 2, bytes: 800 });
    expect(warnings).toHaveLength(2);
    const [at50, at80] = warnings as [string, string];
    // Loki's `|=` keeps a line that contains the text.
    expect(at80).toContain(lineFilters[0]);
    expect(at50).not.toContain(lineFilters[0]);
    expect('A warm catalog refresh failed: STORE_INTERNAL_LIMIT').not.toContain(lineFilters[0]);
  });

  it('stays raised while the limit keeps refusing catalog reads, and clears once it stops', () => {
    const { lineFilters, rangeMs } = catalogRule();
    // The warning repeats within the rule's range, so every evaluation finds one.
    expect(GRAPH_CATALOG_WARNING_REPEAT_MS).toBeLessThan(rangeMs);
    let now = 0;
    const warnings: Array<{ readonly at: number; readonly message: string }> = [];
    const overLimit = createGraphCatalogOverLimitWarning({ now: () => now, warn: message => { warnings.push({ at: now, message }); } });
    // Five hours of reads the limit refuses, one every five minutes; then none.
    const minute = 60_000;
    const refusedUntil = 5 * 60 * minute;
    for (now = 0; now <= refusedUntil; now += 5 * minute) overLimit({ limitBytes: 1000, actualBytes: 1500 });
    const warnedAt = warnings.map(warning => warning.at);
    expect(warnedAt).toEqual([0, 1, 2, 3, 4, 5].map(hour => hour * 60 * minute));
    for (const { message } of warnings) expect(message).toContain(lineFilters[0]);
    // The rule raises while its range holds a matching line: at every minute until the reads stop, and for less than the range after.
    const raisedAt = (at: number) => warnedAt.some(warned => warned <= at && warned > at - rangeMs);
    for (let at = 0; at <= refusedUntil; at += minute) expect(raisedAt(at), `raised at minute ${at / minute}`).toBe(true);
    expect(raisedAt(refusedUntil + rangeMs)).toBe(false);
  });
});
