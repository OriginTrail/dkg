const RFC64_PERSISTENCE_ROOT_OWNERSHIP_V1: unique symbol = Symbol(
  'rfc64-persistence-root-ownership-v1',
);

/**
 * Package-internal proof that the RFC-64 persistence lease is still held.
 * Sibling resources consume this generic authority instead of accepting paths
 * or teaching the public inventory API about their existence.
 */
export interface Rfc64PersistenceRootOwnershipV1 {
  readonly [RFC64_PERSISTENCE_ROOT_OWNERSHIP_V1]: true;
  assertHeldAndGetRootPathV1(): string;
}

const ownershipByInventory = new WeakMap<object, Rfc64PersistenceRootOwnershipV1>();

export function registerRfc64PersistenceRootOwnershipV1(
  inventory: object,
  rootPath: string,
  assertLeaseHeld: () => void,
): void {
  if (ownershipByInventory.has(inventory)) {
    throw new TypeError('RFC-64 persistence root ownership is already registered');
  }
  const ownership = Object.freeze({
    [RFC64_PERSISTENCE_ROOT_OWNERSHIP_V1]: true as const,
    assertHeldAndGetRootPathV1: (): string => {
      assertLeaseHeld();
      return rootPath;
    },
  });
  ownershipByInventory.set(inventory, ownership);
}

export function getRfc64PersistenceRootOwnershipForInventoryV1(
  inventory: object,
): Rfc64PersistenceRootOwnershipV1 {
  const ownership = ownershipByInventory.get(inventory);
  if (ownership === undefined) {
    throw new TypeError('inventory does not own an RFC-64 persistence root');
  }
  return ownership;
}
