// Canary smoke gate (M4): when the `next` dist-tag carries a version newer than
// the testnet tag, update the DESIGNATED canary edge to it, run a compressed
// layered matrix against the canary, and emit a promote / do-not-promote
// verdict. Armed but not runnable until the release-cert fleet exists and the
// release process publishes RCs to `next`.
//
//   RC_CANARY_SSH / RC_CANARY_API    the canary edge (REQUIRED — ours, never a beacon)
//   RC_CANARY_SOAK_MIN               gate duration (default 120 min)
import 'dotenv/config';

if (!process.env.RC_CANARY_SSH || !process.env.RC_CANARY_API) {
    console.error([
        'canary gate armed but not runnable yet. Prerequisites:',
        '  1. a release-cert canary edge we own (RC_CANARY_SSH + RC_CANARY_API)',
        '  2. the release process publishing RCs to the `next` dist-tag before promoting `testnet`',
        'Gate design (implemented here once 1+2 exist): detect next>testnet from the releases table →',
        '`dkg update --allow-prerelease` on the canary → run layered_suite.mjs against the canary',
        '(all sizes, public+private CG, RC_ITERATIONS spread over RC_CANARY_SOAK_MIN) + one blackbox',
        'parity scenario + queue-baseline comparison vs the canary\'s own pre-update hour →',
        'PASS required before the testnet tag is promoted (go/no-go in the release checklist).',
    ].join('\n'));
    process.exit(2);
}

console.error('canary gate: fleet env present but the full gate flow ships with the fleet — see the plan (M4/P2.3).');
process.exit(2);
