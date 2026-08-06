#!/usr/bin/env node
/*
 * Single plain-CJS source of the Blazegraph runtime contract: the pinned
 * image metadata (blazegraph-image.json) AND the namespace-properties XML
 * template. TypeScript consumes it via createRequire
 * (packages/cli/src/daemon/blazegraph-docker.ts); shell consumes it via the
 * CLI below (scripts/devnet.sh, scripts/devnet-blazegraph-native.sh,
 * scripts/ci/verify-blazegraph-image-contract.sh).
 *
 * Must stay dependency-free and buildless: shell callers run this file
 * straight from the repo checkout (or the packed tarball) with a bare `node`,
 * before any workspace build exists.
 */
'use strict';

const fs = require('node:fs');

/**
 * Canonical XML template for a Blazegraph namespace tuned for DKG V10
 * (quads enabled, no truth maintenance, no text index, no statement
 * identifiers). Substitutes `{namespace}` for the namespace name.
 *
 * Blazegraph's loadFromXML matches the SYSTEM DOCTYPE literally (it is never
 * fetched; the dead java.sun.com URL is fine). quads=true is mandatory: the
 * DKG uses named graphs, and quads mode requires inference disabled via
 * NoAxioms.
 */
const BLAZEGRAPH_NAMESPACE_XML_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <entry key="com.bigdata.rdf.sail.namespace">{namespace}</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.quads">true</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.textIndex">false</entry>
  <entry key="com.bigdata.rdf.sail.truthMaintenance">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.axiomsClass">com.bigdata.rdf.axioms.NoAxioms</entry>
</properties>`;

// Namespace names are templated into XML verbatim, so only accept a
// conservative charset — anything needing escaping is rejected outright.
const BLAZEGRAPH_NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function renderBlazegraphNamespaceXml(namespace) {
  if (typeof namespace !== 'string' || !BLAZEGRAPH_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `Blazegraph namespace ${JSON.stringify(namespace)} is invalid: it is templated into XML, so it must match ${BLAZEGRAPH_NAMESPACE_PATTERN}`,
    );
  }
  return BLAZEGRAPH_NAMESPACE_XML_TEMPLATE.replace('{namespace}', namespace);
}

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

// Self-describing key=value lines — consumers address fields by NAME, never
// by position.
function formatBlazegraphImageMetadata(metadata) {
  const parsed = parseBlazegraphImageMetadata(metadata);
  return Object.entries(parsed)
    // Values may themselves contain '=' (dataPath only bans commas), so
    // consumers must split on the FIRST '=' only — or use field mode, which
    // prints bare values and has no delimiter at all.
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

module.exports = {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE,
  formatBlazegraphImageMetadata,
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
