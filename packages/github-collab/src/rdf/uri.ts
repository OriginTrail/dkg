/**
 * URI minting helpers for the GitHub Code Ontology.
 *
 * All URIs follow the pattern: urn:github:{owner}/{repo}/{type}/{id}
 * Namespace: https://ontology.dkg.io/ghcode#
 */

export const GH = 'https://ontology.dkg.io/ghcode#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

// --- Entity URIs ---

export function repoUri(owner: string, repo: string): string {
  return `urn:github:${owner}/${repo}`;
}

export function userUri(login: string): string {
  return `urn:github:user/${encodeURIComponent(login)}`;
}

export function prUri(owner: string, repo: string, number: number): string {
  return `urn:github:${owner}/${repo}/pr/${number}`;
}

export function issueUri(owner: string, repo: string, number: number): string {
  return `urn:github:${owner}/${repo}/issue/${number}`;
}

export function commitUri(owner: string, repo: string, sha: string): string {
  return `urn:github:${owner}/${repo}/commit/${sha}`;
}

export function branchUri(owner: string, repo: string, name: string): string {
  return `urn:github:${owner}/${repo}/branch/${encodeURIComponent(name)}`;
}

export function reviewUri(owner: string, repo: string, prNumber: number, reviewId: number): string {
  return `urn:github:${owner}/${repo}/pr/${prNumber}/review/${reviewId}`;
}

export function reviewCommentUri(owner: string, repo: string, prNumber: number, commentId: number): string {
  return `urn:github:${owner}/${repo}/pr/${prNumber}/comment/${commentId}`;
}

export function issueCommentUri(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return `urn:github:${owner}/${repo}/issue/${issueNumber}/comment/${commentId}`;
}

export function labelUri(owner: string, repo: string, name: string): string {
  return `urn:github:${owner}/${repo}/label/${encodeURIComponent(name)}`;
}

export function milestoneUri(owner: string, repo: string, number: number): string {
  return `urn:github:${owner}/${repo}/milestone/${number}`;
}

export function fileDiffUri(owner: string, repo: string, prNumber: number, path: string): string {
  return `urn:github:${owner}/${repo}/pr/${prNumber}/file/${encodeURIComponent(path)}`;
}

export function fileUri(owner: string, repo: string, path: string): string {
  return `urn:github:${owner}/${repo}/file/${encodeURIComponent(path)}`;
}

export function directoryUri(owner: string, repo: string, path: string): string {
  return `urn:github:${owner}/${repo}/dir/${encodeURIComponent(path)}`;
}

// --- Graph URIs ---

export function generateParanetSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function paranetId(owner: string, repo: string, suffix?: string): string {
  const base = `github-collab:${owner}/${repo}`;
  return suffix ? `${base}:${suffix}` : base;
}

// --- Quad helpers ---

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/** Create a quad with a URI object. */
export function tripleUri(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

/** Create a quad with a string literal object. */
export function tripleStr(subject: string, predicate: string, value: string, graph: string): Quad {
  return { subject, predicate, object: `"${escapeLiteral(value)}"`, graph };
}

/** Create a quad with a typed literal (integer, boolean, dateTime). */
export function tripleTyped(subject: string, predicate: string, value: string, datatype: string, graph: string): Quad {
  return { subject, predicate, object: `"${escapeLiteral(value)}"^^<${datatype}>`, graph };
}

export function tripleInt(subject: string, predicate: string, value: number, graph: string): Quad {
  return tripleTyped(subject, predicate, String(value), `${XSD}integer`, graph);
}

export function tripleBool(subject: string, predicate: string, value: boolean, graph: string): Quad {
  return tripleTyped(subject, predicate, String(value), `${XSD}boolean`, graph);
}

export function tripleDateTime(subject: string, predicate: string, isoDate: string, graph: string): Quad {
  return tripleTyped(subject, predicate, isoDate, `${XSD}dateTime`, graph);
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
