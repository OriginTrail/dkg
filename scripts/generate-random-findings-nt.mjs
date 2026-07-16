#!/usr/bin/env node

import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_OUTPUT = './tmp/findings.synthetic.nt';
const DEFAULT_TARGET_MIB = 12;

const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const targetMiB = Number.parseInt(process.argv[3] ?? String(DEFAULT_TARGET_MIB), 10);

if (!Number.isFinite(targetMiB) || targetMiB < 1) {
  console.error('Target size must be a positive integer MiB value.');
  process.exit(1);
}

await mkdir(dirname(outputPath), { recursive: true });

const targetBytes = targetMiB * 1024 * 1024;
const handle = await open(outputPath, 'w');

let state = 0x12345678;
let bytesWritten = 0;
let personIndex = 0;

function nextInt() {
  state = (1664525 * state + 1013904223) >>> 0;
  return state;
}

function pick(list) {
  return list[nextInt() % list.length];
}

function randHex(len) {
  let out = '';
  while (out.length < len) {
    out += nextInt().toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

function randWord(prefix) {
  return `${prefix}-${randHex(8)}`;
}

function randLiteral(prefix, max = 3) {
  const words = [];
  const count = 1 + (nextInt() % max);
  for (let i = 0; i < count; i += 1) {
    words.push(randWord(prefix));
  }
  return words.join(' ');
}

const countries = ['Croatia', 'Serbia', 'Slovenia', 'Italy', 'Germany', 'France', 'Spain', 'Japan'];
const tags = ['AI', 'RDF', 'Graph', 'Semantic', 'Publisher', 'Agent', 'Knowledge', 'Search'];

try {
  while (bytesWritten < targetBytes) {
    const person = `https://umanitek.ai/dkg/resource/person/${randWord('person')}-${personIndex}`;
    const company = `https://umanitek.ai/dkg/resource/company/${randWord('company')}`;
    const article = `https://umanitek.ai/dkg/resource/article/${randWord('article')}`;
    const project = `https://umanitek.ai/dkg/resource/project/${randWord('project')}`;

    const lines = [
      `<${person}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://umanitek.ai/dkg/ontology/Person> .\n`,
      `<${person}> <http://schema.org/name> "${randLiteral('name', 2)}" .\n`,
      `<${person}> <http://schema.org/email> "${randWord('user')}@example.com" .\n`,
      `<${person}> <http://schema.org/jobTitle> "${randLiteral('role', 2)}" .\n`,
      `<${person}> <http://schema.org/addressCountry> "${pick(countries)}" .\n`,
      `<${person}> <http://schema.org/worksFor> <${company}> .\n`,
      `<${person}> <http://schema.org/affiliation> <${project}> .\n`,
      `<${person}> <http://schema.org/subjectOf> <${article}> .\n`,
      `<${company}> <http://schema.org/name> "${randLiteral('company', 2)}" .\n`,
      `<${company}> <http://schema.org/description> "${randLiteral('company-desc', 5)}" .\n`,
      `<${project}> <http://schema.org/name> "${randLiteral('project', 3)}" .\n`,
      `<${project}> <http://schema.org/keywords> "${pick(tags)}, ${pick(tags)}, ${pick(tags)}" .\n`,
      `<${article}> <http://schema.org/headline> "${randLiteral('headline', 4)}" .\n`,
      `<${article}> <http://schema.org/articleBody> "${randLiteral('body', 12)}" .\n`,
      `<${article}> <http://schema.org/datePublished> "2026-03-${String((nextInt() % 28) + 1).padStart(2, '0')}"^^<http://www.w3.org/2001/XMLSchema#date> .\n`,
    ];

    const chunk = lines.join('');
    await handle.write(chunk);
    bytesWritten += Buffer.byteLength(chunk);
    personIndex += 1;
  }
} finally {
  await handle.close();
}

console.log(`Wrote ${bytesWritten} bytes to ${outputPath}`);
