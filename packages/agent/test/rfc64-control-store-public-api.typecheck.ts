import * as publicApi from '../src/index.js';

type PublicApiHasRawControlStoreOpener =
  'openRfc64ControlObjectStoreV1' extends keyof typeof publicApi ? true : false;

// Package consumers cannot construct the cache without the aggregate
// persistence owner; direct-source tests retain a guarded internal seam.
const rawControlStoreOpenerIsNotPublic: PublicApiHasRawControlStoreOpener = false;

void rawControlStoreOpenerIsNotPublic;
