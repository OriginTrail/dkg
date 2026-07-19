import * as packageRoot from '../src/index.js';
import * as productionControlStoreModule from '../src/rfc64/control-object-store-v1.js';

type PackageRootHasRawControlStoreOpener =
  'openRfc64ControlObjectStoreV1' extends keyof typeof packageRoot ? true : false;
type PackageRootHasControlStoreLayout =
  'RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH' extends keyof typeof packageRoot
    ? true
    : false;
type ProductionModuleHasRawControlStoreOpener =
  'openRfc64ControlObjectStoreV1' extends keyof typeof productionControlStoreModule
    ? true
    : false;
type ProductionModuleHasTestOpener =
  'createRfc64ControlObjectStoreTestOpenerV1' extends
  keyof typeof productionControlStoreModule ? true : false;

// The stable package root intentionally withholds the implementation-shaped
// cache API until an RFC-64 public workflow consumes it.
const packageRootHasRawControlStoreOpener: PackageRootHasRawControlStoreOpener = false;
const packageRootHasControlStoreLayout: PackageRootHasControlStoreLayout = false;
const productionModuleHasRawControlStoreOpener: ProductionModuleHasRawControlStoreOpener = false;
const productionModuleHasTestOpener: ProductionModuleHasTestOpener = false;

// @ts-expect-error Low-level store types are not part of the stable package root.
type PackageRootStoreType = packageRoot.Rfc64ControlObjectStoreV1;

// @ts-expect-error The package exports map blocks emitted internal subpaths.
type PublishedInternalControlStoreModule = typeof import('@origintrail-official/dkg-agent/dist/rfc64/control-object-store-v1-internal.js');

void packageRootHasRawControlStoreOpener;
void packageRootHasControlStoreLayout;
void productionModuleHasRawControlStoreOpener;
void productionModuleHasTestOpener;
void (undefined as PackageRootStoreType | undefined);
void (undefined as PublishedInternalControlStoreModule | undefined);
