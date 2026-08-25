#!/usr/bin/env node
// `nsm calibration export` — emits the per-period calibration JSON for this
// seat. Usage: node dist/cli/calibration-export.mjs [DKG_HOME] > out.json
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..");
const { exportCalibration } = await import(join(dist, "subs/calibration.js"));
const home = join(process.argv[2] ?? process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`, "marketplace");
process.stdout.write(JSON.stringify(exportCalibration(home, new Date()), null, 2) + "\n");
