// The serialized build identity shared by release tooling and source builds.
import fs from 'node:fs';
import path from 'node:path';

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
  const outputPath = path.join(rootDir, 'packages', 'cli', 'build-info.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { outputPath, payload };
}
