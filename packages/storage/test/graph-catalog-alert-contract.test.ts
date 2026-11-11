import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_GRAPH_CATALOG_MAX_BYTES_ENV } from '../src/index.js';
import { createGraphCatalogSizeRecorder } from '../src/graph-catalog-metrics.js';
// The observability alert specs, built as tools/observability/generate-observability.mjs builds them.
import { buildAlerts } from '../../../tools/observability/lib/alerts.mjs';
import { promNodeProfile } from '../../../tools/observability/lib/profile.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('the graph catalog alert and the warning it reads', () => {
  it('matches the 80 % warning the recorder logs, and neither the 50 % warning nor another one', () => {
    const { specs } = buildAlerts({ nodeProfile: promNodeProfile('instance'), VM_UID: 'vm', LOKI_UID: 'loki' });
    const rule = specs.find((spec: { title: string }) => spec.title.startsWith('Graph catalog at 80%'));
    expect(rule?.expr).toContain('severity_text=`WARN`');
    const lineFilters = [...String(rule?.expr).matchAll(/\|= `([^`]*)`/g)].map(match => match[1]!);
    expect(lineFilters).toHaveLength(1);

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
});
