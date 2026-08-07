import { types as utilTypes } from 'node:util';

declare const SYSTEM_RECORD_LANE_ACTIVATION_BRAND: unique symbol;

/** Empty process-local authority. Its descriptor exists only in the private table. */
export type OwnedSystemRecordLaneActivationV1 = {
  readonly [SYSTEM_RECORD_LANE_ACTIVATION_BRAND]: 'owned-system-record-lane-activation-v1';
};

export interface SystemRecordLaneActivationDescriptorV1 {
  readonly networkId: string;
  readonly kinds: readonly ['agents'];
  readonly mode: 'shadow' | 'authoritative';
}

export interface SystemRecordLaneActivationIssuerV1 {
  issue(descriptor: SystemRecordLaneActivationDescriptorV1): OwnedSystemRecordLaneActivationV1;
}

export interface SystemRecordLaneActivationReaderV1 {
  read(activation: unknown): SystemRecordLaneActivationDescriptorV1;
}

export interface SystemRecordLaneActivationRegistryV1 {
  readonly issuer: SystemRecordLaneActivationIssuerV1;
  readonly reader: SystemRecordLaneActivationReaderV1;
}

interface RegisteredActivationV1 {
  readonly registryIdentity: object;
  readonly descriptor: SystemRecordLaneActivationDescriptorV1;
}

const REGISTERED_ACTIVATIONS = new WeakMap<object, RegisteredActivationV1>();
const NETWORK_ID_PATTERN_V1 = /^[A-Za-z0-9._:-]+$/;
const MAX_NETWORK_ID_BYTES_V1 = 128;
const UTF8 = new TextEncoder();

/** Snapshot the closed activation record without invoking caller accessors or iterators. */
export function snapshotSystemRecordLaneActivationDescriptorV1(
  activation: unknown,
): SystemRecordLaneActivationDescriptorV1 {
  if (
    activation === null ||
    typeof activation !== 'object' ||
    Array.isArray(activation) ||
    utilTypes.isProxy(activation) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(activation))
  ) {
    throw new Error('system-record lane activation must be a plain data object');
  }

  const expected = ['kinds', 'mode', 'networkId'];
  const ownKeys = Reflect.ownKeys(activation);
  if (
    ownKeys.length !== expected.length ||
    ownKeys.some((key) => typeof key !== 'string') ||
    [...(ownKeys as string[])].sort().some((key, index) => key !== expected[index])
  ) {
    throw new Error('system-record lane activation has unknown or missing fields');
  }

  const readDataField = (key: string): unknown => {
    const field = Object.getOwnPropertyDescriptor(activation, key);
    if (!field?.enumerable || !Object.prototype.hasOwnProperty.call(field, 'value')) {
      throw new Error('system-record lane activation fields must be enumerable data properties');
    }
    return field.value;
  };

  const networkId = readDataField('networkId');
  if (
    typeof networkId !== 'string' ||
    networkId.length === 0 ||
    UTF8.encode(networkId).byteLength > MAX_NETWORK_ID_BYTES_V1 ||
    !NETWORK_ID_PATTERN_V1.test(networkId)
  ) {
    throw new Error('system-record lane activation networkId is not canonical');
  }

  const kinds = readDataField('kinds');
  if (!Array.isArray(kinds) || utilTypes.isProxy(kinds)) {
    throw new Error('system-record lane activation kinds must be the closed [agents] tuple');
  }
  const kindKeys = Reflect.ownKeys(kinds);
  const length = Object.getOwnPropertyDescriptor(kinds, 'length');
  const first = Object.getOwnPropertyDescriptor(kinds, '0');
  if (
    kindKeys.length !== 2 ||
    !kindKeys.includes('length') ||
    !kindKeys.includes('0') ||
    length?.value !== 1 ||
    length.enumerable ||
    !first?.enumerable ||
    !Object.prototype.hasOwnProperty.call(first, 'value') ||
    first.value !== 'agents'
  ) {
    throw new Error('system-record lane activation kinds must be the closed [agents] tuple');
  }

  const mode = readDataField('mode');
  if (mode !== 'shadow' && mode !== 'authoritative') {
    throw new Error('system-record lane activation mode is invalid');
  }

  return Object.freeze({ networkId, kinds: Object.freeze(['agents'] as const), mode });
}

/**
 * Create one non-interchangeable issuer/reader pair. Production captures the reader in
 * the controller and the issuer in the later lifecycle owner; neither belongs in config.
 */
export function createSystemRecordLaneActivationRegistryV1(
  assertAvailable?: () => void,
): SystemRecordLaneActivationRegistryV1 {
  const registryIdentity = Object.freeze(Object.create(null) as object);
  const issuer: SystemRecordLaneActivationIssuerV1 = Object.freeze({
    issue(value: SystemRecordLaneActivationDescriptorV1): OwnedSystemRecordLaneActivationV1 {
      assertAvailable?.();
      const descriptor = snapshotSystemRecordLaneActivationDescriptorV1(value);
      const handle = Object.freeze(Object.create(null) as object) as OwnedSystemRecordLaneActivationV1;
      REGISTERED_ACTIVATIONS.set(handle, { registryIdentity, descriptor });
      return handle;
    },
  });
  const reader: SystemRecordLaneActivationReaderV1 = Object.freeze({
    read(activation: unknown): SystemRecordLaneActivationDescriptorV1 {
      if (activation === null || typeof activation !== 'object') {
        throw new Error('system-record lane activation capability is invalid');
      }
      const registered = REGISTERED_ACTIVATIONS.get(activation);
      if (registered?.registryIdentity !== registryIdentity) {
        throw new Error('system-record lane activation capability is invalid or belongs to another runtime');
      }
      return registered.descriptor;
    },
  });
  return Object.freeze({ issuer, reader });
}
