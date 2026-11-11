import { readFileSync } from 'node:fs';

function weightMap(weights, field, label) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights) || !Object.keys(weights).length) {
    throw new Error(`${field} must be a non-empty weight map`);
  }
  for (const [name, duration] of Object.entries(weights)) {
    if (!name.startsWith('test/') || !name.endsWith('.test.ts') || /[\r\n\\]/.test(name)
        || name.split('/').some((part) => part === '..' || part === '.' || !part)) {
      throw new Error(`invalid ${label} test path: ${name}`);
    }
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`invalid duration for ${name}`);
  }
  return weights;
}

/**
 * Validate a generated shard timing snapshot and expose only immutable planning
 * inputs. Reviewed estimates for files no source run measured yet (for example
 * a newly split suite) count as known weights; a file may not be both.
 */
export function loadVitestTimings(file, label) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.schemaVersion !== 1) throw new Error('expected schemaVersion 1');
    if (!Number.isFinite(raw.perFileOverheadMs) || raw.perFileOverheadMs < 0) {
      throw new Error('perFileOverheadMs must be a non-negative finite number');
    }
    const measured = weightMap(raw.bodyWeightsMs, 'bodyWeightsMs', label);
    const estimated = raw.estimatedBodyWeightsMs === undefined
      ? {}
      : weightMap(raw.estimatedBodyWeightsMs, 'estimatedBodyWeightsMs', label);
    const both = Object.keys(estimated).find((name) => Object.hasOwn(measured, name));
    if (both) throw new Error(`${both} is both measured and estimated`);
    return Object.freeze({
      perFileOverheadMs: raw.perFileOverheadMs,
      bodyWeightsMs: Object.freeze({ ...measured, ...estimated }),
    });
  } catch (error) {
    throw new Error(`Invalid ${label} timing snapshot ${file}: ${error.message}`);
  }
}
