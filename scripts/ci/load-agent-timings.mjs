import { readFileSync } from 'node:fs';

/** Validate the generated format and expose only immutable planning inputs. */
export function loadAgentTimings(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.schemaVersion !== 1) throw new Error('expected schemaVersion 1');
    if (!Number.isFinite(raw.perFileOverheadMs) || raw.perFileOverheadMs < 0) {
      throw new Error('perFileOverheadMs must be a non-negative finite number');
    }
    const weights = raw.bodyWeightsMs;
    if (!weights || typeof weights !== 'object' || Array.isArray(weights) || !Object.keys(weights).length) {
      throw new Error('bodyWeightsMs must be a non-empty weight map');
    }
    for (const [name, duration] of Object.entries(weights)) {
      if (!name.startsWith('test/') || !name.endsWith('.test.ts') || /[\r\n\\]/.test(name)
          || name.split('/').some((part) => part === '..' || part === '.' || !part)) {
        throw new Error(`invalid agent test path: ${name}`);
      }
      if (!Number.isFinite(duration) || duration < 0) throw new Error(`invalid duration for ${name}`);
    }
    return Object.freeze({
      perFileOverheadMs: raw.perFileOverheadMs,
      bodyWeightsMs: Object.freeze({ ...weights }),
    });
  } catch (error) {
    throw new Error(`Invalid agent timing snapshot ${file}: ${error.message}`);
  }
}
