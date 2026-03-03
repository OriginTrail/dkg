#!/usr/bin/env node
/**
 * Publish the production coordination plan JSON into a DKG paranet.
 *
 * Usage:
 *   node 01_PRODUCTION_PLAN_DKG.publish.mjs --plan ./01_PRODUCTION_PLAN_DKG.json --paranet dkgv9-production
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DG = 'https://ontology.dkg.io/devgraph#';
const PLAN = 'https://ontology.dkg.io/plan#';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function literal(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function ual(id) {
  return `urn:dkgv9:plan:${id}`;
}

function quad(subject, predicate, object, graph) {
  return { subject, predicate, object, graph };
}

async function loadToken() {
  const file = join(process.env.DKG_HOME ?? join(homedir(), '.dkg'), 'auth.token');
  if (!existsSync(file)) return undefined;
  const raw = await readFile(file, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return undefined;
}

async function main() {
  const planPath = arg('plan', new URL('./01_PRODUCTION_PLAN_DKG.json', import.meta.url).pathname);
  const paranetId = arg('paranet', 'dkgv9-production');
  const apiPort = Number(process.env.DKG_API_PORT ?? '9200');

  const graph = `did:dkg:paranet:${paranetId}`;
  const raw = await readFile(planPath, 'utf-8');
  const plan = JSON.parse(raw);

  const quads = [];

  // Root plan entity
  const root = ual(`${plan.planId}:v:${plan.version}`);
  quads.push(quad(root, RDF_TYPE, `${PLAN}ProductionPlan`, graph));
  quads.push(quad(root, `${DG}name`, literal(plan.planId), graph));
  quads.push(quad(root, `${DG}status`, literal('active'), graph));
  quads.push(quad(root, `${DG}summary`, literal('DKGV9 production coordination plan (graph-native)'), graph));
  quads.push(quad(root, `${PLAN}version`, literal(plan.version), graph));
  quads.push(quad(root, `${PLAN}updatedAt`, literal(plan.updatedAt), graph));

  for (const ws of plan.workstreams ?? []) {
    const s = ual(ws.id);
    quads.push(quad(s, RDF_TYPE, ws.class ?? `${DG}Task`, graph));
    quads.push(quad(s, `${DG}name`, literal(ws.name), graph));
    quads.push(quad(s, `${DG}status`, literal(ws.status), graph));
    quads.push(quad(s, `${DG}assignee`, literal(ws.assignee), graph));
    quads.push(quad(s, `${DG}summary`, literal(ws.summary), graph));
    quads.push(quad(s, `${DG}description`, literal(ws.description), graph));
    quads.push(quad(s, `${PLAN}priority`, literal(ws.priority), graph));
    quads.push(quad(s, `${PLAN}roiHypothesis`, literal(ws.roiHypothesis), graph));
    quads.push(quad(root, `${PLAN}hasWorkstream`, s, graph));
  }

  for (const t of plan.tasks ?? []) {
    const s = ual(t.id);
    quads.push(quad(s, RDF_TYPE, t.class ?? `${DG}Task`, graph));
    quads.push(quad(s, `${DG}name`, literal(t.name), graph));
    quads.push(quad(s, `${DG}status`, literal(t.status), graph));
    quads.push(quad(s, `${DG}assignee`, literal(t.assignee), graph));
    quads.push(quad(s, `${DG}description`, literal(t.description), graph));
    quads.push(quad(s, `${PLAN}priority`, literal(t.priority), graph));
    for (const dep of t.dependsOn ?? []) {
      quads.push(quad(s, `${DG}dependsOn`, ual(dep), graph));
    }
    quads.push(quad(root, `${PLAN}hasTask`, s, graph));
  }

  for (const e of plan.experiments ?? []) {
    const s = ual(e.id);
    quads.push(quad(s, RDF_TYPE, e.class ?? `${DG}Task`, graph));
    quads.push(quad(s, `${DG}name`, literal(e.name), graph));
    quads.push(quad(s, `${DG}status`, literal(e.status), graph));
    quads.push(quad(s, `${DG}summary`, literal(e.summary), graph));
    quads.push(quad(s, `${PLAN}hypothesis`, literal(e.hypothesis), graph));
    quads.push(quad(s, `${PLAN}priority`, literal(e.priority), graph));
    for (const a of e.arms ?? []) quads.push(quad(s, `${PLAN}hasArm`, literal(a), graph));
    for (const m of e.metrics ?? []) quads.push(quad(s, `${PLAN}hasMetric`, literal(m), graph));
    for (const c of e.successCriteria ?? []) quads.push(quad(s, `${PLAN}successCriterion`, literal(c), graph));
    quads.push(quad(root, `${PLAN}hasExperiment`, s, graph));
  }

  for (const d of plan.initialDecisions ?? []) {
    const s = ual(d.id);
    quads.push(quad(s, RDF_TYPE, d.class ?? `${DG}Decision`, graph));
    quads.push(quad(s, `${DG}summary`, literal(d.summary), graph));
    quads.push(quad(s, `${DG}rationale`, literal(d.rationale), graph));
    quads.push(quad(s, `${DG}madeBy`, literal(d.madeBy), graph));
    quads.push(quad(s, `${DG}madeAt`, literal(d.madeAt), graph));
    quads.push(quad(root, `${PLAN}hasDecision`, s, graph));
  }

  const token = await loadToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`http://127.0.0.1:${apiPort}/api/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ paranetId, quads }),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`Publish failed (${res.status}): ${body}`);
    process.exit(1);
  }

  console.log(`Published production plan to paranet '${paranetId}'`);
  console.log(`Root entity: ${root}`);
  console.log(`Quads: ${quads.length}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
