// Published packages carry exact versions of the libp2p family so that an npm
// install runs the versions CI tested from pnpm-lock.yaml. Exact versions on the
// packages that import libp2p are not enough on their own: npm places a package
// from the first dependent it processes, in install-path order, so a caret range
// on another @libp2p/* package would install the newest release next to ours.
// The package nodes install (the CLI) therefore also pins every family package
// that other packages depend on; npm processes it before anything below it.
import { parse } from 'yaml';

export const LIBP2P_FAMILY = /^(libp2p|@libp2p\/[^/]+|@chainsafe\/[^/]+|@multiformats\/[^/]+|retimeable-signal)$/;
export const INSTALL_ROOT_PACKAGE = '@origintrail-official/dkg';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function nameOf(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : undefined;
}

/**
 * From the lockfile: `versions`, family package name -> versions in its
 * `packages` section, and `dependedOn`, the family packages that another
 * package in the lockfile (not a workspace package) depends on.
 */
export function lockfileFamily(lockText) {
  const lock = parse(lockText) ?? {};
  const versions = new Map();
  for (const key of Object.keys(lock.packages ?? {})) {
    const name = nameOf(key);
    if (!name || !LIBP2P_FAMILY.test(name)) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(key.slice(name.length + 1));
  }
  const dependedOn = new Set();
  for (const snapshot of Object.values(lock.snapshots ?? {})) {
    for (const name of Object.keys({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
      if (LIBP2P_FAMILY.test(name)) dependedOn.add(name);
    }
  }
  return { versions, dependedOn };
}

/**
 * One message per violation. `manifests` are the published packages'
 * package.json objects; `lockFamily` comes from lockfileFamily.
 */
export function findLibp2pPinViolations({ manifests, lockFamily: { versions, dependedOn } }) {
  const violations = [];
  for (const [name, locked] of versions) {
    if (locked.size > 1) violations.push(`pnpm-lock.yaml has ${name} at ${[...locked].sort().join(', ')}: an npm install would mix versions; keep one`);
  }
  for (const manifest of manifests) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!LIBP2P_FAMILY.test(name)) continue;
        const locked = [...(versions.get(name) ?? [])];
        if (!EXACT_VERSION.test(spec)) violations.push(`${manifest.name} ${field}: ${name} is "${spec}"; use the exact version from pnpm-lock.yaml (${locked.join(', ') || 'not locked'})`);
        else if (!locked.includes(spec)) violations.push(`${manifest.name} ${field}: ${name} is ${spec} but pnpm-lock.yaml has ${locked.join(', ') || 'none'}`);
      }
    }
  }
  const root = manifests.find((manifest) => manifest.name === INSTALL_ROOT_PACKAGE);
  if (!root) violations.push(`${INSTALL_ROOT_PACKAGE} is not among the published packages`);
  else {
    for (const name of [...dependedOn].sort()) {
      if (root.dependencies?.[name] === undefined) violations.push(`${INSTALL_ROOT_PACKAGE} dependencies: add ${name} ${[...(versions.get(name) ?? [])].join(', ')}; other packages depend on it, so npm installs take its version from the CLI`);
    }
  }
  return violations;
}
