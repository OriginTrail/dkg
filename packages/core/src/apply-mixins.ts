/**
 * Copies own-prototype members from each holder class onto a target class —
 * the standard TS handbook mixin pattern behind the DKGAgent and
 * EVMChainAdapter splits. Holder classes define cohesive method groups
 * (extending a shared base class for `this` state); the target merges their
 * declarations via `interface Target extends ...` and adopts their
 * implementations at module load via this helper.
 *
 * `constructor` is skipped, so the target keeps its own. Each member must come
 * from exactly one holder. A plain copy would let the later holder in the list
 * silently replace the earlier one's implementation, so a name defined by two
 * holders throws at module load instead.
 */
export function applyMixins(
  derivedCtor: { name: string; prototype: object },
  holders: Array<{ name: string; prototype: object }>,
): void {
  const owners = new Map<string, string>();
  for (const holder of holders) {
    for (const propName of Object.getOwnPropertyNames(holder.prototype)) {
      if (propName === 'constructor') continue;
      const owner = owners.get(propName);
      if (owner !== undefined) {
        throw new Error(
          `${derivedCtor.name} mixin collision: '${propName}' is defined by both ${owner} and ${holder.name}`,
        );
      }
      owners.set(propName, holder.name);
      const descriptor = Object.getOwnPropertyDescriptor(holder.prototype, propName);
      if (descriptor) {
        Object.defineProperty(derivedCtor.prototype, propName, descriptor);
      }
    }
  }
}
