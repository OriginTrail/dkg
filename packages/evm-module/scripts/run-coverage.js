#!/usr/bin/env node
'use strict';
// Run Hardhat coverage with fixed args. Ignores extra flags (e.g. --run from turbo/pnpm)
// so that passthrough CLI arguments do not break Hardhat.
const { execSync } = require('child_process');
const cmd = 'npx hardhat coverage --config hardhat.config.ts';
execSync(cmd, { stdio: 'inherit' });
