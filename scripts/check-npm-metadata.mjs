import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PATTERNS = [
  /dkg-v9/i,
  /DKG V9/i,
];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT_DIR, 'packages');

function firstMatchSample(value) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  let matchIndex = -1;
  for (const pattern of FORBIDDEN_PATTERNS) {
    const idx = lower.search(new RegExp(pattern.source, 'i'));
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }
  if (matchIndex === -1) {
    return normalized.slice(0, 120);
  }
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(normalized.length, matchIndex + 100);
  return normalized.slice(start, end);
}

function hasForbiddenText(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectViolations() {
  const violations = [];
  const packageDirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });

  for (const entry of packageDirs) {
    if (!entry.isDirectory()) continue;

    const packageDir = path.join(PACKAGES_DIR, entry.name);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const pkg = readJson(packageJsonPath);
    if (pkg.private) continue;

    const repository =
      typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository?.url ?? '';
    const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url ?? '';

    const fieldsToCheck = [
      { field: 'description', value: pkg.description ?? '' },
      { field: 'repository', value: repository },
      { field: 'homepage', value: pkg.homepage ?? '' },
      { field: 'bugs', value: bugs },
    ];

    for (const field of fieldsToCheck) {
      if (!hasForbiddenText(field.value)) continue;
      violations.push({
        packageName: pkg.name,
        location: `${path.relative(ROOT_DIR, packageJsonPath)}#${field.field}`,
        sample: firstMatchSample(field.value),
      });
    }

    const readmePath = path.join(packageDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, 'utf8');
      if (hasForbiddenText(readme)) {
        violations.push({
          packageName: pkg.name,
          location: `${path.relative(ROOT_DIR, readmePath)}#content`,
          sample: firstMatchSample(readme),
        });
      }
    }
  }

  return violations;
}

const violations = collectViolations();

if (violations.length > 0) {
  console.error('Found stale v9 npm metadata/readme references:\n');
  for (const violation of violations) {
    console.error(`- ${violation.packageName}: ${violation.location}`);
    console.error(`  ${violation.sample}`);
  }
  process.exit(1);
}

console.log('NPM metadata check passed: no stale v9 references in publishable packages.');
