#!/usr/bin/env node
/*
 * Plain-CJS facade for the pinned image metadata and the storage-owned
 * Blazegraph namespace contract. Shell callers consume the CLI below while
 * TypeScript imports the declared package subpath.
 *
 * TypeScript and workspace consumers import the declared public
 * `@origintrail-official/dkg/blazegraph-runtime-contract` subpath, while shell
 * callers run this file directly. Both this facade and the canonical storage
 * contract are buildless CJS assets, so they work before workspace builds.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Load the one storage-owned implementation without making source-tree shell
 * callers depend on an installed workspace. In a checkout the canonical file
 * is next to this package under packages/storage. At pack time the runtime
 * asset copier materializes a byte-for-byte package-local copy so the
 * standalone published facade remains buildless as well.
 */
function loadBlazegraphNamespaceContract() {
  const candidates = [
    path.resolve(__dirname, '../storage/blazegraph-namespace-contract.cjs'),
    path.resolve(__dirname, 'blazegraph-namespace-contract.cjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }

  // Retain package-subpath compatibility for non-standard layouts that install
  // the storage dependency but omit the generated package-local asset.
  return require('@origintrail-official/dkg-storage/blazegraph-namespace-contract');
}

const blazegraphNamespaceContract = loadBlazegraphNamespaceContract();
const {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE,
  assertBlazegraphNamespace,
  normalizeBlazegraphNamespace,
  renderBlazegraphNamespaceXml,
} = blazegraphNamespaceContract;

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
  if (!dataPath.startsWith('/') || /[\s,]/.test(dataPath)) {
    throw new Error(
      `${source}: dataPath must be an absolute container path without commas or whitespace`,
    );
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

// Self-describing key=value lines — consumers address fields by NAME, never
// by position.
function formatBlazegraphImageMetadata(metadata) {
  const parsed = parseBlazegraphImageMetadata(metadata);
  return Object.entries(parsed)
    // Values may themselves contain '=' (dataPath bans commas and whitespace), so
    // consumers must split on the FIRST '=' only — or use field mode, which
    // prints bare values and has no delimiter at all.
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

module.exports = {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE,
  assertBlazegraphNamespace,
  formatBlazegraphImageMetadata,
  normalizeBlazegraphNamespace,
  parseBlazegraphImageMetadata,
  readBlazegraphImageMetadata,
  renderBlazegraphNamespaceXml,
};

if (require.main === module) {
  const usage = [
    'Usage:',
    '  node blazegraph-image-metadata.cjs <blazegraph-image.json> [field ...]',
    '      No fields: print every field as key=value lines.',
    '      With fields: print one requested field value per line.',
    '  node blazegraph-image-metadata.cjs --namespace-xml <namespace>',
    '      Print the canonical Blazegraph namespace-properties XML.',
  ].join('\n');
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--namespace-xml') {
      if (args.length !== 2) {
        console.error(usage);
        process.exitCode = 2;
      } else {
        console.log(renderBlazegraphNamespaceXml(args[1]));
      }
    } else {
      const [filePath, ...fields] = args;
      if (!filePath) {
        console.error(usage);
        process.exitCode = 2;
      } else {
        // The whole object is validated first even when a single field is
        // requested — an invalid contract must never half-succeed.
        const metadata = readBlazegraphImageMetadata(filePath);
        if (fields.length === 0) {
          console.log(formatBlazegraphImageMetadata(metadata));
        } else {
          const values = fields.map((field) => {
            if (!Object.hasOwn(metadata, field)) {
              throw new Error(
                `Unknown Blazegraph metadata field "${field}" — known fields: ${Object.keys(metadata).join(', ')}`,
              );
            }
            return String(metadata[field]);
          });
          console.log(values.join('\n'));
        }
      }
    }
  } catch (error) {
    // Surface the underlying errno (ENOENT vs EACCES vs EISDIR) — shell
    // callers only see this one line.
    const detail = error instanceof Error && error.cause ? ` (${String(error.cause)})` : '';
    console.error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    process.exitCode = 1;
  }
}
