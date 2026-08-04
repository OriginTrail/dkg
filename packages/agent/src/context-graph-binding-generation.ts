// SPDX-License-Identifier: Apache-2.0

interface ContextGraphBindingGenerationOwner {
  readonly contextGraphBindingGenerations?: Map<string, number>;
}

const fallbackGenerations = new WeakMap<object, Map<string, number>>();

function generationsFor(owner: object): Map<string, number> {
  const owned = (owner as ContextGraphBindingGenerationOwner).contextGraphBindingGenerations;
  if (owned) return owned;
  let fallback = fallbackGenerations.get(owner);
  if (!fallback) {
    fallback = new Map<string, number>();
    fallbackGenerations.set(owner, fallback);
  }
  return fallback;
}

export function bumpContextGraphBindingGeneration(
  owner: object,
  localCgId: string,
): number {
  const generations = generationsFor(owner);
  const generation = (generations.get(localCgId) ?? 0) + 1;
  generations.set(localCgId, generation);
  return generation;
}

export function captureContextGraphBindingGeneration(
  owner: object,
  localCgId: string,
): number {
  return generationsFor(owner).get(localCgId) ?? 0;
}

export function isContextGraphBindingGenerationCurrent(
  owner: object,
  localCgId: string,
  generation: number,
): boolean {
  return captureContextGraphBindingGeneration(owner, localCgId) === generation;
}

export function clearContextGraphBindingGeneration(
  owner: object,
  localCgId: string,
): void {
  generationsFor(owner).delete(localCgId);
}
