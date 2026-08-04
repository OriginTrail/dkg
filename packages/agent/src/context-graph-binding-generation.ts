// SPDX-License-Identifier: Apache-2.0

export function bumpContextGraphBindingGeneration(
  generations: Map<string, number>,
  localCgId: string,
): number {
  const generation = (generations.get(localCgId) ?? 0) + 1;
  generations.set(localCgId, generation);
  return generation;
}

export function captureContextGraphBindingGeneration(
  generations: Map<string, number>,
  localCgId: string,
): number {
  return generations.get(localCgId) ?? 0;
}

export function isContextGraphBindingGenerationCurrent(
  generations: Map<string, number>,
  localCgId: string,
  generation: number,
): boolean {
  return captureContextGraphBindingGeneration(generations, localCgId) === generation;
}

export function clearContextGraphBindingGeneration(
  generations: Map<string, number>,
  localCgId: string,
): void {
  generations.delete(localCgId);
}
