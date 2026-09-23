import { vi } from 'vitest';
import { getMetrics } from '@origintrail-official/dkg-core';

export interface InvalidSparqlTermCount {
  value: number;
  adapter: string;
  operation: string;
  position: string;
  kind: string;
  enforcement: string;
}

/**
 * Capture what sparql-terms' observe mode reports: every counter point and
 * every warn line. Without a registered meter provider all counters share one
 * no-op instance, so points are told apart by their `enforcement` label.
 */
export function observeInvalidSparqlTerms() {
  const add = vi.spyOn(getMetrics().storeSparqlInvalidTermsTotal, 'add');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    get counted(): InvalidSparqlTermCount[] {
      return add.mock.calls
        .filter(([, attributes]) => attributes !== undefined && 'enforcement' in attributes)
        .map(([value, attributes]) => ({ value, ...attributes }) as InvalidSparqlTermCount);
    },
    get warnings(): string[] {
      return warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('[storage] '));
    },
    restore(): void {
      add.mockRestore();
      warn.mockRestore();
    },
  };
}
