#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const REQUIRED_CURRENT_METADATA = ["status", "version", "audience", "doc_type"];
const IGNORED_DIRS = new Set([
  ".git",
  ".worktrees",
  ".orchestrator",
  ".devnet",
  "node_modules",
]);
const CURRENT_PUBLIC_PATHS = [
  "docs/README.md",
  "docs/getting-started/",
  "docs/active-now/",
  "docs/how-dkg-works/",
  "docs/use-dkg/",
  "docs/references/",
  "docs/agent-context/",
];
const OFFICIAL_IMPORTED_REFERENCE_DOCS = new Set([
  "docs/active-now/dkg-v10-bounty.md",
  "docs/getting-started/dkg-v10-t-c.md",
]);
const OFFICIAL_IMPORTED_BLOBS = new Map([
  ["docs/active-now/dkg-v10-bounty.md", "14de40536b48df51cb378455ffe01fe0a4940442"],
  ["docs/getting-started/dkg-v10-t-c.md", "d192eea991ec211c9e574c0cf624779ce5995d5b"],
  ["docs/.gitbook/assets/dkg-memory-hr.png", "873e852da840b437889c3b2e78c85c4300e166dd"],
  ["docs/.gitbook/assets/dkg_v10_bounty_program_high_res_white_bg.png", "7c41a77e7792df4dfde8e3ca262067d662083edb"],
]);
const AGENT_CONTEXT_PATHS = [
  "llms.txt",
  "llms-full.txt",
  "docs/agent-context/",
];
const STALE_DOC_PATHS = [
  "docs/index.md",
  "docs/overview.md",
  "docs/architecture/",
  "docs/build/",
  "docs/understand/",
  "docs/operate/",
  "docs/for-ai-agents/",
  "docs/agents/",
  "docs/contributing/",
  "docs/onboarding/",
  "docs/diagrams/",
  "docs/future_ideas/",
  "docs/use_cases/",
  "docs/bugs/",
  "docs/experiments/",
  "docs/operator/",
  "docs/plans/",
  "docs/reports/",
  "docs/runbooks/",
  "docs/security/",
  "docs/setup/",
  "docs/specs/",
  "docs/testing/",
  "docs/messenger.md",
  "docs/messenger-operator.md",
  "docs/messenger-add-protocol.md",
  "docs/p2p-resilience.md",
  "docs/RFC38_LU6_TWO_LAPTOP_TESTNET_RUNBOOK.md",
  "docs/TESTNET_RESET.md",
  "docs/SWM_LARGE_LITERAL_STORAGE_PR_DESCRIPTION.md",
  "docs/SWM_LARGE_PAYLOAD_STORAGE_AMPLIFICATION_PR.md",
  "docs/SWM_SENDER_KEY_EPOCH_DESIGN.md",
  "docs/SWM_SENDER_KEY_EPOCH_DESIGN.docx",
  "docs/dkg-v10-prototype-v5.1-jurij-feedback-populated (1).html",
  "docs/FEEDBACK.md",
  "docs/RELEASE.md",
  "docs/TWO-LAPTOP-DEMO.md",
  "docs/PHASE2_ARCHITECTURE_PLAN.md",
  "docs/v9-protocol-operations.md",
  "docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md",
  "docs/SPEC_CAPACITY_AND_GAS.md",
  "docs/SPEC_PART1_MARKETPLACE.md",
  "docs/SPEC_PART2_ECONOMY.md",
  "docs/SPEC_PART3_EXTENSIONS.md",
  "docs/SPEC_TRUST_LAYER.md",
  "docs/SPEC_VERIFIED_KAS.md",
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

function isVersionedArchivePath(relativePath) {
  return relativePath.startsWith("docs/archive/v8/") || relativePath.startsWith("docs/archive/v9/");
}

function isArchiveVersionRoot(relativePath) {
  return /^docs\/archive\/v[0-9]+(?:\/|$)/.test(relativePath);
}

function isDocsAdrPath(relativePath) {
  return /(^|\/)docs\/adr\/[^/]+\.mdx?$/.test(relativePath);
}

function isStaleDocPath(relativePath) {
  return STALE_DOC_PATHS.some((candidate) => {
    if (candidate.endsWith("/")) {
      return relativePath.startsWith(candidate);
    }

    return relativePath === candidate;
  });
}

function isAgentContextPath(relativePath) {
  return AGENT_CONTEXT_PATHS.some((candidate) => {
    if (candidate.endsWith("/")) {
      return relativePath.startsWith(candidate);
    }

    return relativePath === candidate;
  });
}

function isCurrentPublicPath(relativePath) {
  return CURRENT_PUBLIC_PATHS.some((candidate) => {
    if (candidate.endsWith("/")) {
      return relativePath.startsWith(candidate);
    }

    return relativePath === candidate;
  });
}

function isOfficialImportedReferenceDoc(relativePath) {
  return OFFICIAL_IMPORTED_REFERENCE_DOCS.has(relativePath);
}

function walkFiles(rootDir) {
  const entries = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir, { withFileTypes: true })
    : [];
  const files = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
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

function isCurrentDoc(relativePath, metadata) {
  return isCurrentPublicPath(relativePath) || isCurrentMetadata(metadata);
}

function validateCurrentMetadata(relativePath, metadata, errors) {
  if (isOfficialImportedReferenceDoc(relativePath)) {
    return;
  }

  if (!isCurrentDoc(relativePath, metadata)) {
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

function extractMarkdownLinks(content) {
  const links = [];
  const inlineLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const referenceLinkPattern = /^\s*\[[^\]]+\]:\s+(\S+)/gm;

  for (const match of content.matchAll(inlineLinkPattern)) {
    links.push(match[1]);
  }

  for (const match of content.matchAll(referenceLinkPattern)) {
    links.push(match[1]);
  }

  return links;
}

function normalizeDocLink(relativePath, linkTarget) {
  const target = linkTarget.trim().replace(/^<|>$/g, "");
  if (
    !target ||
    target.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return null;
  }

  const withoutFragment = target.split("#")[0].split("?")[0];
  if (!withoutFragment) {
    return null;
  }

  const normalized = withoutFragment.startsWith("/")
    ? path.posix.normalize(withoutFragment.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), withoutFragment));

  return normalized;
}

function normalizePathReference(relativePath, pathReference) {
  const target = pathReference.trim().replace(/^<|>$/g, "");
  if (!target) {
    return null;
  }

  if (target.startsWith("/") || target.startsWith("docs/")) {
    return path.posix.normalize(target.replace(/^\/+/, ""));
  }

  return path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), target));
}

function validateCurrentLinks(relativePath, content, metadata, errors) {
  if (!isCurrentDoc(relativePath, metadata)) {
    return;
  }

  for (const link of extractMarkdownLinks(content)) {
    const normalized = normalizeDocLink(relativePath, link);
    if (normalized && isVersionedArchivePath(normalized)) {
      errors.push(`${relativePath}: current docs must not link to ${normalized}`);
    }
  }
}

function validateRepoFacingLinks(relativePath, content, errors) {
  if (!isMarkdown(relativePath)) {
    return;
  }

  const staleRefs = new Set();
  for (const link of extractMarkdownLinks(content)) {
    const normalized = normalizeDocLink(relativePath, link);
    if (!normalized) {
      continue;
    }

    if (isVersionedArchivePath(normalized) || isStaleDocPath(normalized)) {
      if (relativePath === "docs/SUMMARY.md" && isVersionedArchivePath(normalized)) {
        continue;
      }
      staleRefs.add(normalized);
    }
  }

  for (const staleRef of staleRefs) {
    errors.push(`${relativePath}: repo-facing docs must not reference stale docs path ${staleRef}`);
  }
}

function validateExistingRepoLinks(rootDir, relativePath, content, errors) {
  if (!isMarkdown(relativePath)) {
    return;
  }

  const missingRefs = new Set();
  for (const link of extractMarkdownLinks(content)) {
    const normalized = normalizeDocLink(relativePath, link);
    if (!normalized) {
      continue;
    }

    if (!fs.existsSync(path.resolve(rootDir, normalized))) {
      missingRefs.add(normalized);
    }
  }

  for (const missingRef of missingRefs) {
    errors.push(`${relativePath}: markdown link target does not exist: ${missingRef}`);
  }
}

function validateArchivePlacement(relativePath, errors) {
  if (!relativePath.startsWith("docs/archive/")) {
    return;
  }

  if (!isArchiveVersionRoot(relativePath)) {
    errors.push(`${relativePath}: archived docs must live under docs/archive/<version>/`);
  }
}

function validateAdrPlacement(relativePath, errors) {
  if (isDocsAdrPath(relativePath)) {
    errors.push(`${relativePath}: ADRs must live under .ai/adr/`);
  }
}

function validateAgentContext(relativePath, content, errors) {
  if (!isAgentContextPath(relativePath)) {
    return;
  }

  const archiveRefs = new Set();
  for (const link of extractMarkdownLinks(content)) {
    const normalized = normalizeDocLink(relativePath, link);
    if (normalized && isVersionedArchivePath(normalized)) {
      archiveRefs.add(normalized);
    }
  }

  const archivePathPattern = /(?:^|[\s"'(<])((?:\.{1,2}\/)*(?:docs\/)?archive\/v[89]\/[^\s"')>]*)/g;
  for (const match of content.matchAll(archivePathPattern)) {
    const normalized = normalizePathReference(relativePath, match[1]);
    if (isVersionedArchivePath(normalized)) {
      archiveRefs.add(normalized);
    }
  }

  for (const archiveRef of archiveRefs) {
    errors.push(`${relativePath}: agent context must not reference ${archiveRef}`);
  }
}

function gitBlobSha1(content) {
  return crypto
    .createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function validateOfficialImports(rootDir, errors) {
  for (const [relativePath, expectedSha] of OFFICIAL_IMPORTED_BLOBS) {
    const absolutePath = path.resolve(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${relativePath}: missing official imported GitBook file`);
      continue;
    }

    const actualSha = gitBlobSha1(fs.readFileSync(absolutePath));
    if (actualSha !== expectedSha) {
      errors.push(`${relativePath}: official GitBook import changed; expected blob ${expectedSha}, got ${actualSha}`);
    }
  }
}

function main() {
  const rootDir = process.env.DOCS_CORPUS_ROOT
    ? path.resolve(process.env.DOCS_CORPUS_ROOT)
    : process.cwd();
  const errors = [];
  const files = walkFiles(rootDir);

  for (const file of files) {
    const relativePath = toPosix(path.relative(rootDir, file));
    validateAdrPlacement(relativePath, errors);
    validateArchivePlacement(relativePath, errors);
    if (isArchivePath(relativePath)) {
      continue;
    }

    if (!isMarkdown(relativePath) && !isAgentContextPath(relativePath)) {
      continue;
    }

    const content = fs.readFileSync(file, "utf8");
    const metadata = parseFrontMatter(content);
    if (isMarkdown(relativePath)) {
      validateCurrentMetadata(relativePath, metadata, errors);
      validateCurrentLinks(relativePath, content, metadata, errors);
      validateRepoFacingLinks(relativePath, content, errors);
      validateExistingRepoLinks(rootDir, relativePath, content, errors);
    }
    validateAgentContext(relativePath, content, errors);
  }
  validateOfficialImports(rootDir, errors);

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
