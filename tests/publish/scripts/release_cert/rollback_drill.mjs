// Rollback drill (M5): exercises dkg update → verify → dkg rollback → verify →
// dkg update on a DESIGNATED release-cert fleet edge. Requires SSH access to a
// fleet node we own — it must never run against the shared beacons or any
// operator node. Until the fleet exists (M3 hardware), this script is armed but
// refuses to run.
//
//   RC_FLEET_SSH        user@host of the designated drill edge (REQUIRED)
//   RC_FLEET_API        its API base URL (REQUIRED)
//   RC_DRILL_BUDGET_S   per-step time budget (default 300)
import { execFileSync } from 'child_process';
import 'dotenv/config';

const SSH = process.env.RC_FLEET_SSH;
const API = process.env.RC_FLEET_API;
const BUDGET_S = Number(process.env.RC_DRILL_BUDGET_S || 300);

if (!SSH || !API) {
    console.error('rollback drill armed but not runnable: set RC_FLEET_SSH + RC_FLEET_API once the release-cert fleet edge exists (never point this at the shared beacons or operator nodes).');
    process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', SSH, cmd], { encoding: 'utf8', timeout: BUDGET_S * 1000 });

async function waitReady(expectVersion) {
    const t0 = Date.now();
    while (Date.now() - t0 < BUDGET_S * 1000) {
        try {
            const res = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const s = await res.json();
                if (!expectVersion || s.version === expectVersion) return { ms: Date.now() - t0, version: s.version };
            }
        } catch { /* not up yet */ }
        await sleep(5000);
    }
    throw new Error(`node not ready within ${BUDGET_S}s`);
}

async function main() {
    const before = await waitReady();
    console.log(`• drill start: version ${before.version}`);

    console.log('• dkg update…');
    ssh('dkg update || true');
    const updated = await waitReady();
    console.log(`✅ updated + ready in ${Math.round(updated.ms / 1000)}s (version ${updated.version})`);

    console.log('• dkg rollback…');
    ssh('dkg rollback');
    const rolled = await waitReady();
    console.log(`✅ rollback + ready in ${Math.round(rolled.ms / 1000)}s (version ${rolled.version})`);
    if (rolled.version === updated.version && updated.version !== before.version) {
        throw new Error('rollback did not change the running version');
    }

    console.log('• dkg update (restore)…');
    ssh('dkg update || true');
    const restored = await waitReady();
    console.log(`✅ drill complete: running ${restored.version}`);
}

main().catch((err) => {
    console.error(`❌ rollback drill: ${err.message}`);
    process.exit(1);
});
