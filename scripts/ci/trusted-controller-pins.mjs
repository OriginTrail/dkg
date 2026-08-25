#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKOUT_PATTERN = /actions\/checkout@[0-9a-f]{40}/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function scalarFromBlock(block, key) {
  const matches = [...block.matchAll(new RegExp(`^\\s+${key}:\\s*([^#\\n]+?)\\s*$`, 'gm'))];
  if (matches.length !== 1) return undefined;
  return matches[0][1].replace(/^['"]|['"]$/g, '');
}

export function trustedControllerCheckouts(source, sourceName = '<workflow>') {
  const lines = source.split('\n');
  const checkouts = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const pathMatch = lines[lineIndex].match(/^(\s+)path:\s*trusted-ci\s*(?:#.*)?$/);
    if (!pathMatch) continue;

    let stepStart = -1;
    let stepIndent = -1;
    for (let cursor = lineIndex; cursor >= 0; cursor -= 1) {
      const stepMatch = lines[cursor].match(/^(\s*)-\s+(?:name|uses):/);
      if (stepMatch && stepMatch[1].length < pathMatch[1].length) {
        stepStart = cursor;
        stepIndent = stepMatch[1].length;
        break;
      }
    }
    if (stepStart === -1) {
      throw new Error(`${sourceName}:${lineIndex + 1}: trusted-ci path is not inside a workflow step`);
    }

    let stepEnd = lines.length;
    for (let cursor = stepStart + 1; cursor < lines.length; cursor += 1) {
      const nextStep = lines[cursor].match(/^(\s*)-\s+(?:name|uses):/);
      if (nextStep && nextStep[1].length === stepIndent) {
        stepEnd = cursor;
        break;
      }
    }
    const block = lines.slice(stepStart, stepEnd).join('\n');
    if (!CHECKOUT_PATTERN.test(block)) {
      throw new Error(`${sourceName}:${lineIndex + 1}: trusted-ci path must belong to a SHA-pinned checkout step`);
    }
    checkouts.push({
      sourceName,
      line: lineIndex + 1,
      repository: scalarFromBlock(block, 'repository'),
      ref: scalarFromBlock(block, 'ref'),
    });
  }
  return checkouts;
}

export function validateTrustedControllerPins(workflows) {
  const allCheckouts = [];
  for (const workflow of workflows) {
    const checkouts = trustedControllerCheckouts(workflow.source, workflow.sourceName);
    if (checkouts.length !== workflow.expectedCount) {
      throw new Error(
        `${workflow.sourceName}: expected ${workflow.expectedCount} trusted-ci checkouts, found ${checkouts.length}`,
      );
    }
    allCheckouts.push(...checkouts);
  }

  for (const checkout of allCheckouts) {
    if (checkout.repository !== 'OriginTrail/dkg') {
      throw new Error(`${checkout.sourceName}:${checkout.line}: trusted checkout must use OriginTrail/dkg`);
    }
    if (!SHA_PATTERN.test(checkout.ref ?? '')) {
      throw new Error(`${checkout.sourceName}:${checkout.line}: trusted checkout needs an immutable 40-character ref`);
    }
  }

  const refs = new Set(allCheckouts.map((checkout) => checkout.ref));
  if (refs.size !== 1) {
    throw new Error(`trusted CI controller checkouts use ${refs.size} different refs`);
  }
  return { ref: allCheckouts[0].ref, checkouts: allCheckouts };
}

function parseWorkflowArgument(argument) {
  const separator = argument.lastIndexOf('=');
  if (separator <= 0) throw new Error(`expected WORKFLOW=COUNT, received: ${argument}`);
  const filePath = argument.slice(0, separator);
  const expectedCount = Number(argument.slice(separator + 1));
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`invalid trusted checkout count in: ${argument}`);
  }
  return {
    sourceName: filePath,
    source: fs.readFileSync(filePath, 'utf8'),
    expectedCount,
  };
}

export function runTrustedControllerValidator(argv) {
  try {
    if (argv.length === 0) throw new Error('provide at least one WORKFLOW=COUNT argument');
    const result = validateTrustedControllerPins(argv.map(parseWorkflowArgument));
    console.log(result.ref);
    return 0;
  } catch (error) {
    console.error(`trusted-controller-pins: ${error.message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runTrustedControllerValidator(process.argv.slice(2));
}
