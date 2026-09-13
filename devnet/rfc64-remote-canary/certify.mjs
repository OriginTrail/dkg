// SPDX-License-Identifier: Apache-2.0

// Public facade retained for operators and tests. Cohesive implementation
// lives in the configuration, transport, phase, and artifact modules.
export { RemoteCanaryError } from './errors.mjs';
export {
  createRemoteCanaryCohortRefV1,
  validateRemoteCanaryConfigV1,
} from './config.mjs';
export {
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
} from './phases.mjs';
export { runBoundedCommandV1 } from './transport.mjs';
export {
  runRemoteCanaryArtifactLifecycleV1,
  writeArtifactAtomicV1,
} from './artifact.mjs';
