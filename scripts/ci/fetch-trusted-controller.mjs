#!/usr/bin/env node

// Fetches the trusted CI controller revision the workflows pin, so tests that
// read the pinned controller's files from git history also run in a shallow
// checkout. The ref comes from the canonical pin validator, not workflow text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateTrustedControllerPins } from './trusted-controller-pins.mjs';

export const PINNED_WORKFLOWS = Object.freeze(['ci.yml', 'evm-integration.yml']);

export function pinnedControllerRef(
  readWorkflow = (name) => fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'),
) {
  return validateTrustedControllerPins(
    PINNED_WORKFLOWS.map((name) => ({ sourceName: name, source: readWorkflow(name) })),
  ).ref;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', pinnedControllerRef()], { stdio: 'inherit' });
}
