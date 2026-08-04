#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseBlazegraphImageMetadata(value, source = 'Blazegraph image metadata') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: expected an object with image, containerPort, and dataPath`);
  }

  const image = typeof value.image === 'string' ? value.image.trim() : '';
  if (image.length === 0) {
    throw new Error(`${source}: image must be a non-empty string`);
  }

  const { containerPort } = value;
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65_535) {
    throw new Error(`${source}: containerPort must be an integer from 1 through 65535`);
  }

  const dataPath = typeof value.dataPath === 'string' ? value.dataPath.trim() : '';
  if (!dataPath.startsWith('/') || dataPath.includes(',')) {
    throw new Error(`${source}: dataPath must be an absolute container path without commas`);
  }

  return { image, containerPort, dataPath };
}

function readBlazegraphImageMetadata(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${filePath}: could not read Blazegraph image metadata`, { cause: error });
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${filePath}: Blazegraph image metadata is not valid JSON`, { cause: error });
  }
  return parseBlazegraphImageMetadata(value, filePath);
}

function formatBlazegraphImageMetadata(metadata) {
  const parsed = parseBlazegraphImageMetadata(metadata);
  return `${parsed.image}\t${parsed.containerPort}\t${parsed.dataPath}`;
}

module.exports = {
  formatBlazegraphImageMetadata,
  parseBlazegraphImageMetadata,
  readBlazegraphImageMetadata,
};

if (require.main === module) {
  const [filePath, ...extraArgs] = process.argv.slice(2);
  if (!filePath || extraArgs.length > 0) {
    console.error('Usage: node blazegraph-image-metadata.cjs <blazegraph-image.json>');
    process.exitCode = 2;
  } else {
    try {
      console.log(formatBlazegraphImageMetadata(readBlazegraphImageMetadata(filePath)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
