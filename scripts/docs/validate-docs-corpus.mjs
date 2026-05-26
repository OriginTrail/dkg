#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REQUIRED_CURRENT_METADATA = ["status", "version", "audience", "doc_type"];
const CURRENT_PUBLIC_PATHS = [
  "docs/overview.md",
  "docs/index.md",
  "docs/current/",
  "docs/build/",
  "docs/understand/",
  "docs/operate/",
  "docs/reference/",
  "docs/for-ai-agents/",
  "docs/agents/",
];

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function isMarkdown(filePath) {
  return filePath.endsWith(".md") || filePath.endsWith(".mdx");
}

function isArchivePath(relativePath) {
  return relativePath === "docs/archive" || relativePath.startsWith("docs/archive/");
}

function isCurrentPublicPath(relativePath) {
  return CURRENT_PUBLIC_PATHS.some((candidate) => {
    if (candidate.endsWith("/")) {
      return relativePath.startsWith(candidate);
    }

    return relativePath === candidate;
  });
}

function walkFiles(rootDir) {
  const entries = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir, { withFileTypes: true })
    : [];
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }

    files.push(entryPath);
  }

  return files;
}

function parseFrontMatter(content) {
  if (!content.startsWith("---\n")) {
    return null;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return null;
  }

  const metadata = {};
  const body = content.slice(4, end);
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match) {
      metadata[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  }

  return metadata;
}

function isCurrentMetadata(metadata) {
  return metadata?.status === "current" || metadata?.version === "v10";
}

function validateCurrentMetadata(relativePath, metadata, errors) {
  if (!isCurrentPublicPath(relativePath) && !isCurrentMetadata(metadata)) {
    return;
  }

  if (!metadata) {
    errors.push(`${relativePath}: missing required front matter`);
    return;
  }

  for (const key of REQUIRED_CURRENT_METADATA) {
    if (!metadata[key]) {
      errors.push(`${relativePath}: missing required metadata "${key}"`);
    }
  }

  if (metadata.status && metadata.status !== "current") {
    errors.push(`${relativePath}: current public docs must use status: current`);
  }

  if (metadata.version && metadata.version !== "v10") {
    errors.push(`${relativePath}: current public docs must use version: v10`);
  }
}

function main() {
  const rootDir = process.env.DOCS_CORPUS_ROOT
    ? path.resolve(process.env.DOCS_CORPUS_ROOT)
    : process.cwd();
  const errors = [];
  const markdownFiles = walkFiles(rootDir).filter(isMarkdown);

  for (const file of markdownFiles) {
    const relativePath = toPosix(path.relative(rootDir, file));
    if (isArchivePath(relativePath)) {
      continue;
    }

    const content = fs.readFileSync(file, "utf8");
    validateCurrentMetadata(relativePath, parseFrontMatter(content), errors);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log("docs corpus validation passed");
}

main();
