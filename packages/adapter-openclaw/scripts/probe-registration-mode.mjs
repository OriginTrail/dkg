#!/usr/bin/env node

/**
 * Registration-mode probe runner.
 *
 * Instructs the user how to enable and collect registration-mode diagnostics
 * from the OpenClaw gateway. The actual probing logic lives in DkgNodePlugin
 * and is gated on DKG_PROBE_REGISTRATION_MODE=1.
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const BANNER = `
╔══════════════════════════════════════════════════════════════════════════════╗
║                  DKG Registration-Mode Probe Helper                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

This probe instruments DkgNodePlugin.register() to observe:

  1. Which registrationMode the gateway passes on each call
  2. Which hook-registration mechanisms (api.on, api.registerHook, globalThis)
     accept handlers for typed hooks (before_prompt_build, agent_end, etc.)
  3. Which handlers actually fire at runtime

SETUP:

  1. Set environment variable:
     export DKG_PROBE_REGISTRATION_MODE=1

  2. Restart your OpenClaw gateway:
     dkg stop
     dkg start

  3. Drive test turns:
     - Click "Send" in the DKG Agent Hub (UI turn via dkg-ui channel)
     - Send a test message via Telegram or other channel (non-UI turn)

  4. Collect diagnostic logs:
     Gateway logs will include lines like:
       [dkg-probe] register() called: mode=... call#=... api.on=... api.registerHook=...
       [dkg-probe] HOOK FIRED: event=... via=... mode=...

  5. Triage the output:
     - mode=full and api.on=function confirms typed-hook dispatch
       (Branch A — the adapter's HookSurface typed installs will fire).
     - mode=setup-runtime and api.on=undefined means the gateway is not
       running in full mode; re-check tools.profile and channels config.
     - HOOK FIRED lines show which registration mechanism actually
       delivered the event. Compare against HookSurface stats in
       \`DkgNodePlugin.installHooksIfNeeded\` for dispatch coverage.

NOTES:

  - The probe is silent if DKG_PROBE_REGISTRATION_MODE is not set.
  - Probe handlers log every time a hook fires, so gateway logs may grow.
  - This diagnostic has zero effect on normal agent operation.
`;

console.log(BANNER);

// Optional: tail gateway log if a path was provided. Use `spawn` with an
// argv array (no shell) so the log path cannot be interpreted as a shell
// command — passing an adversarial path like `"; rm -rf ~"` would
// previously run under a shell and execute the tail payload.
const logPath = process.argv[2];
if (logPath) {
  console.log(`\nTailing gateway log: ${logPath}\n`);
  const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Error tailing log: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || code === 130) return;
    if (code !== 0) console.error(`tail exited with code ${code}`);
  });
}
