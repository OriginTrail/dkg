import * as publicApi from '../src/index.js';
import {
  RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1,
  RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS,
  RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY,
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY,
  Rfc64ControlObjectStoreErrorV1,
  type GetVerifiedControlObjectInputV1,
  type Rfc64ControlObjectStoreErrorCodeV1,
  type Rfc64ControlObjectStoreNamespaceDurabilityV1,
  type Rfc64ControlObjectStoreV1,
  type StageVerifiedControlObjectV1,
  type StageVerifiedControlObjectsResultV1,
  type StagedVerifiedControlObjectV1,
  type StoredVerifiedControlObjectV1,
} from '../src/index.js';

type PublicApiHasRawControlStoreOpener =
  'openRfc64ControlObjectStoreV1' extends keyof typeof publicApi ? true : false;

// Package consumers cannot construct the cache without the aggregate
// persistence owner; direct-source tests retain a guarded internal seam.
const rawControlStoreOpenerIsNotPublic: PublicApiHasRawControlStoreOpener = false;

const publicControlStoreRuntimeExports = [
  RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1,
  RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS,
  RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY,
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY,
  Rfc64ControlObjectStoreErrorV1,
] as const;

type PublicControlStoreTypesAreUsable = readonly [
  GetVerifiedControlObjectInputV1,
  Rfc64ControlObjectStoreErrorCodeV1,
  Rfc64ControlObjectStoreNamespaceDurabilityV1,
  Rfc64ControlObjectStoreV1,
  StageVerifiedControlObjectV1,
  StageVerifiedControlObjectsResultV1,
  StagedVerifiedControlObjectV1,
  StoredVerifiedControlObjectV1,
];
const publicControlStoreTypesAreUsable: PublicControlStoreTypesAreUsable | undefined = undefined;

void rawControlStoreOpenerIsNotPublic;
void publicControlStoreRuntimeExports;
void publicControlStoreTypesAreUsable;
