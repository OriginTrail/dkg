// The serialized build identity shared by release tooling and source builds.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function buildInfoPayload({ commit, distTag, ciRun = null, buildTime = new Date().toISOString(), dirty }) {
  if (typeof distTag !== 'string' || distTag.length === 0) {
    throw new Error('--dist-tag is required for build-info generation');
  }
  const resolvedCommit = commit && commit.length > 0 ? commit : 'unknown';
  return {
    commit: resolvedCommit,
    commitShort: resolvedCommit.slice(0, 8) || '00000000',
    buildTime,
    distTag,
    ciRun,
    ...(dirty === undefined ? {} : { dirty }),
  };
}

export function writeBuildMetadata({ rootDir, ...identity }) {
  const payload = buildInfoPayload(identity);
  const outputPath = metadataPath(rootDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { outputPath, payload };
}


function metadataPath(rootDir) {
  return path.join(rootDir, 'packages', 'cli', 'build-info.json');
}

function readBuildMetadata(rootDir) {
  try {
    const text = fs.readFileSync(metadataPath(rootDir), 'utf8');
    const payload = JSON.parse(text);
    if (typeof payload?.commit !== 'string' || payload.commit.length === 0) return null;
    return payload;
  } catch { return null; }
}

export function captureSourceBuildIdentity(rootDir) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Build checkout identity is unavailable');
    return result.stdout.trim();
  };
  try {
    // Archives under another repository must never inherit that parent's identity.
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== fs.realpathSync(rootDir)) {
      throw new Error('Build source does not own the discovered Git repository');
    }
    const head = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error('Invalid Git commit');
    const dirty = git(['status', '--porcelain', '--untracked-files=normal']) !== '';
    return { commit: head + (dirty ? '-dirty' : ''), dirty };
  } catch { return { commit: 'unknown', dirty: null }; }
}

export function certifyCapturedBuildIdentity(rootDir, captured) {
  if (captured.dirty !== false) return captured;
  const current = captureSourceBuildIdentity(rootDir);
  if (current.dirty === null) return current;
  if (current.commit !== captured.commit || current.dirty !== false) {
    return { commit: `${captured.commit}-dirty`, dirty: true };
  }
  return captured;
}

export function devnetBuildCacheMatchesCheckout(rootDir) {
  const current = captureSourceBuildIdentity(rootDir);
  const info = readBuildMetadata(rootDir);
  // Historical clean stamps omit dirty; unknown/dirty evidence never certifies a cache hit.
  return current.dirty === false && info?.commit === current.commit
    && (info.dirty === undefined || info.dirty === false);
}

export function captureDevnetBuild(rootDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'packages', 'cli', 'package.json'), 'utf8'));
  if (manifest.dkgBuildIdentity === 'compiler') return { owner: 'compiler' };
  if (manifest.dkgBuildIdentity !== undefined) throw new Error('Unsupported CLI build identity capability');
  // Historical build commands do not stamp their output. Capture BEFORE they run.
  return { owner: 'legacy', identity: captureSourceBuildIdentity(rootDir) };
}

export function ensureDevnetBuildInfo(rootDir, build) {
  if (build?.owner === 'compiler') {
    const metadata = readBuildMetadata(rootDir);
    if (!metadata) throw new Error('Compiler-owned build did not produce build identity');
    return metadata;
  }
  if (build?.owner !== 'legacy' || !build.identity) {
    throw new Error('Captured prebuild source identity is required for legacy certification');
  }
  const identity = certifyCapturedBuildIdentity(rootDir, build.identity);
  return writeBuildMetadata({ rootDir, distTag: 'devnet', ...identity }).payload;
}
