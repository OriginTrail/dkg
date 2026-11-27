'use strict';

const { createHash } = require('node:crypto');

/**
 * Canonical, buildless Blazegraph namespace contract shared by storage,
 * product/CLI provisioning, shell entry points, and rollout certification.
 * Keeping the policy in this leaf CJS module lets pre-build shell callers use
 * the exact same normalization, validation, and XML rendering as TypeScript.
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

const BLAZEGRAPH_NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function assertBlazegraphNamespace(namespace) {
  if (
    typeof namespace !== 'string'
    || !BLAZEGRAPH_NAMESPACE_PATTERN.test(namespace)
    || namespace === '.'
    || namespace === '..'
  ) {
    throw new Error(
      `Blazegraph namespace ${JSON.stringify(namespace)} is invalid: it must match ${BLAZEGRAPH_NAMESPACE_PATTERN} and cannot be a URL dot segment`,
    );
  }
}

function normalizeBlazegraphNamespace(namespace) {
  if (typeof namespace !== 'string') {
    throw new TypeError('Blazegraph namespace input must be a string');
  }
  const candidate = namespace
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const slug = candidate.length === 0 || candidate === '.' || candidate === '..'
    ? 'dkg-node'
    : candidate;
  if (slug.length <= 128) return slug;
  const suffix = createHash('sha256').update(slug).digest('hex').slice(0, 12);
  return `${slug.slice(0, 115)}-${suffix}`;
}

function renderBlazegraphNamespaceXml(namespace) {
  assertBlazegraphNamespace(namespace);
  return BLAZEGRAPH_NAMESPACE_XML_TEMPLATE.replace('{namespace}', namespace);
}

module.exports = Object.freeze({
  BLAZEGRAPH_NAMESPACE_PATTERN,
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE,
  assertBlazegraphNamespace,
  normalizeBlazegraphNamespace,
  renderBlazegraphNamespaceXml,
});
