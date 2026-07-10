// SPDX-License-Identifier: Apache-2.0

/**
 * Copies own prototype keys (including module-private symbol methods) from
 * each holder class onto a target class,
 * implementing the mixin assembly for the DKGAgent split. Holder classes
 * define cohesive method groups (extending `DKGAgentBase` for shared `this`
 * state); `DKGAgent` merges their declarations via `interface DKGAgent extends ...`
 * and adopts their implementations at module load via this helper.
 *
 * Standard TS handbook mixin pattern. `constructor` is skipped — DKGAgent
 * keeps its own (inherited from DKGAgentBase).
 */
export function applyMixins(derivedCtor: { prototype: object }, holders: Array<{ prototype: object }>): void {
  for (const holder of holders) {
    for (const propName of Reflect.ownKeys(holder.prototype)) {
      if (propName === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(holder.prototype, propName);
      if (descriptor) {
        Object.defineProperty(derivedCtor.prototype, propName, descriptor);
      }
    }
  }
}
