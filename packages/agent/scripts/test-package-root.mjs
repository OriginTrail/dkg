import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await import('@origintrail-official/dkg-agent');
const legacyAgent = await import('@origintrail-official/dkg-agent/dist/dkg-agent.js');
const legacyChainReconciler = await import(
  '@origintrail-official/dkg-agent/dist/chain-reconciler.js'
);
const legacyCatalogSync = await import(
  '@origintrail-official/dkg-agent/dist/dkg-agent-rfc64-catalog-sync.js'
);
const publicCatalogActivation = await import(
  '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1'
);
const require = createRequire(import.meta.url);
const packageManifest = require('@origintrail-official/dkg-agent/package.json');
const expectedRfc64PolicyCells = [
  'public-open',
  'public-curated',
  'private-open',
  'private-curated',
];
const expectedRfc64PublicCatalogReconciliationOutcomes = [
  'already-applied',
  'applied',
  'staged-only',
  'not-found',
  'failed',
  'dropped',
  'closed',
];

if (
  typeof root.DKGAgent !== 'function'
  || typeof legacyAgent.DKGAgent !== 'function'
  || typeof root.Rfc64PublicCatalogSuccessorProducerV1 !== 'function'
  || typeof root.computeRfc64AppliedInventoryDigestV1 !== 'function'
  || typeof root.classifyRfc64PolicyCellV1 !== 'function'
  || typeof root.composeFinalizedVmSetV1 !== 'function'
  || typeof root.FinalizedVmCompositionErrorV1 !== 'function'
  || typeof root.assertRecoverableAuthorAttestationV1 !== 'function'
  || typeof root.RecoverableAuthorAttestationErrorV1 !== 'function'
  || typeof root.maintainRfc64SwmAuthorInventoryV1 !== 'function'
  || typeof root.removeRfc64SwmAuthorInventoryRowV1 !== 'function'
  || typeof root.Rfc64SwmAuthorInventoryProducerErrorV1 !== 'function'
  || typeof root.Rfc64CatalogReconciliationTerminalErrorV1 !== 'function'
  || typeof root.Rfc64CatalogSynchronizationErrorV1 !== 'function'
  || typeof root.Rfc64CatalogResponsibilityRegistryV1 !== 'function'
  || typeof legacyCatalogSync.Rfc64CatalogSynchronizationErrorV1 !== 'function'
) {
  throw new Error('published agent entry points did not expose required root APIs');
}
if (
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE' in root
  || 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME' in root
  || 'ContextGraphAuthorityUnavailableError' in root
  || 'isContextGraphAuthorityUnavailableMarker' in root
) {
  throw new Error('internal authority marker machinery leaked from the package root');
}
const internalPromoteModule = 'internal/promote/context-graph-agent-gate-authority';
// One structural namespace rule protects current and future implementation files.
// Check runtime imports and generated declaration/map paths against the built package.
for (const extension of ['js', 'd.ts', 'js.map', 'd.ts.map']) {
  const specifier = `@origintrail-official/dkg-agent/dist/${internalPromoteModule}.${extension}`;
  try {
    await import(specifier);
    throw new Error(`internal promote module unexpectedly resolved: ${specifier}`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
  try {
    require.resolve(specifier);
    throw new Error(`internal promote module unexpectedly resolved via require: ${specifier}`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
}
const legacySynchronizationError = new legacyCatalogSync.Rfc64CatalogSynchronizationErrorV1(
  'no-authorized-provider',
  'legacy-code',
);
if (
  legacySynchronizationError.terminalReason !== 'no-authorized-provider'
  || legacySynchronizationError.code !== 'legacy-code'
) {
  throw new Error('historical catalog synchronization error fields changed');
}
const modernSynchronizationError = new root.Rfc64CatalogReconciliationTerminalErrorV1({
  outcome: 'failed',
  error: Object.assign(new Error('modern failure'), { code: 'modern-code' }),
});
if (
  !(modernSynchronizationError
    instanceof legacyCatalogSync.Rfc64CatalogSynchronizationErrorV1)
  || modernSynchronizationError.code !== 'modern-code'
  || modernSynchronizationError.outcome !== 'failed'
) {
  throw new Error('terminal reconciliation errors lost synchronization compatibility');
}
try {
  root.assertRecoverableAuthorAttestationV1({
    seal: { authorSchemeVersion: 'unsupported' },
  });
  throw new Error('package-root author attestation guard accepted an unsupported scheme');
} catch (error) {
  if (
    !(error instanceof root.Rfc64PublicCatalogNativeReceiverErrorV1)
    || error.code !== 'catalog-native-receiver-transfer'
  ) {
    throw new Error('package-root author attestation guard changed its receiver error contract');
  }
}
const requiredCatalogMethods = [
  'acceptRfc64CatalogAccessSnapshotV1',
  'publishAuthorCatalogGenesisV1',
  'publishAuthorCatalogExactSetSuccessorV1',
  'recordRfc64PublicCatalogAssetV1',
  'recordConfirmedRfc64PublicCatalogAssetV1',
  'synchronizeRfc64PublicCatalogFromProviderV1',
  'readRfc64PublicCatalogBootstrapStatusV1',
  'whenRfc64PublicCatalogBootstrapIdleV1',
];
for (const method of requiredCatalogMethods) {
  if (
    typeof root.DKGAgent.prototype[method] !== 'function'
    || typeof legacyAgent.DKGAgent.prototype[method] !== 'function'
  ) {
    throw new Error(`published DKGAgent entry points did not expose ${method}`);
  }
}
if (
  !Array.isArray(root.RFC64_POLICY_CELLS_V1)
  || !Object.isFrozen(root.RFC64_POLICY_CELLS_V1)
  || root.RFC64_POLICY_CELLS_V1.length !== expectedRfc64PolicyCells.length
  || root.RFC64_POLICY_CELLS_V1.some(
    (cell, index) => cell !== expectedRfc64PolicyCells[index]
  )
) {
  throw new Error('package root did not expose the closed RFC-64 policy-cell list');
}
if (
  !Array.isArray(root.RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1)
  || !Object.isFrozen(root.RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1)
  || root.RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1.length
    !== expectedRfc64PublicCatalogReconciliationOutcomes.length
  || root.RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1.some(
    (outcome, index) => outcome !== expectedRfc64PublicCatalogReconciliationOutcomes[index]
  )
) {
  throw new Error('package root did not expose the closed RFC-64 reconciliation outcome list');
}
if (
  typeof root.isRfc64CatalogReconciliationSuccessOutcomeV1 !== 'function'
  || typeof root.isRfc64CatalogReconciliationFailureOutcomeV1 !== 'function'
  || typeof root.isRfc64PublicCatalogReceiverSuccessCompletionV1 !== 'function'
  || typeof root.isRfc64PublicCatalogReceiverFailureCompletionV1 !== 'function'
) {
  throw new Error('package root did not expose RFC-64 reconciliation outcome guards');
}
if (packageManifest.name !== '@origintrail-official/dkg-agent') {
  throw new Error('historical package.json subpath no longer resolves');
}
const legacyReconcileResult = await legacyChainReconciler.reconcileContextGraph(
  {
    getKCCount: async () => 2,
    getHeadBlock: async () => undefined,
    reconcileOrdinal: async () => ({ status: 'pending' }),
    maxOrdinalsPerPass: 1,
    persistWatermark: () => undefined,
    confirmationDepth: 0,
    log: () => undefined,
  },
  { watermark: 0, ahead: new Map(), scanOrdinal: 0 },
  'package-subpath-compatibility',
  1n,
);
if (
  legacyReconcileResult.hasMore !== true
  || legacyReconcileResult.shouldContinueImmediately !== false
) {
  throw new Error('historical chain reconciler result lost hasMore compatibility');
}
if (typeof publicCatalogActivation.resolveRfc64PublicCatalogActivationConfigV1 !== 'function') {
  throw new Error('public RFC-64 activation subpath did not expose the complete resolver');
}
if (
  typeof publicCatalogActivation.resolveRfc64PublicCatalogActivationChainIdentityV1
  !== 'function'
) {
  throw new Error('public RFC-64 activation subpath did not expose the chain-identity resolver');
}
if (typeof publicCatalogActivation.resolveRfc64PublicCatalogControlsV1 !== 'function') {
  throw new Error('public RFC-64 activation subpath did not expose catalog-control normalization');
}

const digestAuthor = '0x1111111111111111111111111111111111111111';
const digestRows = [10, 2].map((number) => ({
  kaId: ((BigInt(digestAuthor) << 96n) | BigInt(number)).toString(),
  catalogRowDigest: `0x${(number * 4).toString(16).padStart(64, '0')}`,
  contentDigest: `0x${((number * 4) + 1).toString(16).padStart(64, '0')}`,
  sealDigest: `0x${((number * 4) + 2).toString(16).padStart(64, '0')}`,
  kaUal: `did:dkg:otp:20430/${digestAuthor}/${number}`,
  activatedTripleCount: number + 1,
}));
const publicDigest = root.computeRfc64AppliedInventoryDigestV1({
  catalogScopeDigest: '0x6287b105b87dbacce48f7702a54e9410ba4a5d52475b986288042eb75464bbe2',
  rows: digestRows,
});
if (publicDigest !== '0x6d273d5f5fc1acbfe6836168c7159b747fe3df549d2d5bddcd8bf409ff58ea01') {
  throw new Error('package-root applied-inventory digest did not use numeric KA-ID order');
}
const publicRfc64Modules = [
  'author-catalog-producer.js',
  'catalog-row-authorship.js',
  'inventory-v1/candidate.js',
  'inventory-v1/index.js',
  'inventory-v1/lifecycle-adapter.js',
  'inventory-v1/open.js',
  'inventory-v1/scalars.js',
  'inventory-v1/sql.js',
  'inventory-v1/statements.js',
  'public-catalog-activation-config-v1.js',
  'swm-author-inventory-producer-v1.js',
];
const blockedRfc64Modules = [
  'catalog-synchronization-error-v1.js',
  'catalog-access-policy-v1.js',
  'catalog-authority-config-v1.js',
  'catalog-responsibility-registry-v1.js',
  'release-native-catalog-authority-v1.js',
  'legacy-swm-boundary-v1.js',
  'catalog-rollout-authority-v1.js',
  'catalog-rollout-authority-reconciliation-v1.js',
  'applied-catalog-authority-transition-v1.js',
  'catalog-semantic-authority-transition-v1.js',
  'public-catalog-native-errors-v1.js',
  'catalog-applied-head-coordinator-v1.js',
  'catalog-native-scoped-read-capability-v1-internal.js',
  'catalog-native-scoped-read-provider-v1.js',
  'catalog-head-lineage-v1.js',
  'catalog-peers-v1.js',
  'catalog-transport-authorization-v1.js',
  'catalog-transport-wire-v1-internal.js',
  'control-envelope-signer-v1.js',
  'control-object-store-v1-internal.js',
  'control-object-store-v1.js',
  'durable-file-store-v1.js',
  'inventory-v1/exact-record.js',
  'inventory-v1/swm-author-inventory-auth-v1.js',
  'inventory-v1/swm-author-inventory-commit-plan.js',
  'inventory-v1/swm-author-inventory-contracts.js',
  'inventory-v1/swm-author-inventory-mutation.js',
  'inventory-v1/swm-author-inventory-persistence.js',
  'inventory-v1/swm-author-inventory-sql-codec.js',
  'finalized-policy-agent-precommit-v1.js',
  'finalized-policy-verifier-v1.js',
  'finalized-private-placement-repair-store-v1.js',
  'catalog-synchronization-evidence-v1.js',
  'finalized-swm-retirement-lifecycle-receipt-v1.js',
  'finalized-vm-agent-precommit-v1.js',
  'finalized-vm-composer-v1.js',
  'finalized-vm-runtime-v1.js',
  'finalized-vm-store-materializer-v1.js',
  'ka-bundle-store-v1-internal.js',
  'ka-bundle-store-v1.js',
  'open-catalog-policy-v1.js',
  'persistence-layout-v1.js',
  'persistence-root-ownership-v1-internal.js',
  'persistence-v1.js',
  'policy-cell-v1.js',
  'public-catalog-current-head-discovery-v1.js',
  'public-catalog-inventory-completeness-v1.js',
  'public-catalog-native-reconciler-v1.js',
  'public-catalog-native-committed-head-token-v1.js',
  'public-catalog-native-receiver-v1.js',
  'public-catalog-native-transport-v1.js',
  'public-open-catalog-scope-v1.js',
  'public-catalog-reconciliation-failure-v1.js',
  'public-catalog-reconciliation-outcome-v1.js',
  'public-catalog-receiver-task-lifecycle-v1.js',
  'public-catalog-receiver-v1.js',
  'public-catalog-service-v1.js',
  'public-catalog-issuer-delegation-v1.js',
  'public-catalog-successor-asset-v1.js',
  'public-catalog-successor-producer-v1.js',
  'public-catalog-transport-v1.js',
  'recoverable-author-attestation-v1.js',
  'secure-filesystem-policy-v1.js',
  'swm-recovery-coordinator-v1.js',
  'swm-recovery-plan-v1.js',
  'swm-inventory-catalog-reconciler-v1.js',
  'swm-catalog-durable-asset-resolver-v1.js',
  'swm-inventory-shadow-runtime-v1.js',
  'abort-v1.js',
  'catalog-mutation-runtime-v1.js',
  'catalog-runtime-v1.js',
  'coalescing-supervisor-v1.js',
  'supervisor-status-v1.js',
  'serialized-scope-runtime-v1.js',
];
const packageExports = packageManifest.exports;
const emittedRfc64Modules = await listEmittedRfc64Modules();
const classifiedRfc64Modules = new Set([
  ...publicRfc64Modules,
  ...blockedRfc64Modules,
]);

for (const path of emittedRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (!Object.hasOwn(packageExports, subpath) || !classifiedRfc64Modules.has(path)) {
    throw new Error(`emitted RFC-64 module is not explicitly classified: ${path}`);
  }
}
for (const path of classifiedRfc64Modules) {
  if (!emittedRfc64Modules.includes(path)) {
    throw new Error(`classified RFC-64 module was not emitted: ${path}`);
  }
}
for (const path of publicRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (packageExports[subpath] !== subpath) {
    throw new Error(`legacy RFC-64 module is not explicitly public: ${path}`);
  }
  await import(`@origintrail-official/dkg-agent/dist/rfc64/${path}`);
}

for (const path of blockedRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (packageExports[subpath] !== null) {
    throw new Error(`internal RFC-64 module is not explicitly blocked: ${path}`);
  }
  try {
    await import(`@origintrail-official/dkg-agent/dist/rfc64/${path}`);
    throw new Error(`internal RFC-64 module unexpectedly resolved: ${path}`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
}

if (packageExports['./dist/rfc64/*'] !== null) {
  throw new Error('unclassified RFC-64 deep imports are not blocked by default');
}
if (packageExports['./dist/*'] !== './dist/*') {
  throw new Error('historical non-RFC-64 ./dist/* compatibility was not preserved');
}

async function listEmittedRfc64Modules() {
  const rootPath = fileURLToPath(new URL('../dist/rfc64/', import.meta.url));
  const pending = [rootPath];
  const modules = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        modules.push(relative(rootPath, entryPath).split(sep).join('/'));
      }
    }
  }
  return modules.sort();
}
