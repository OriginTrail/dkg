// Published packages carry exact versions of the libp2p family so that an npm
// install runs the versions CI tested from pnpm-lock.yaml. Exact versions on the
// packages that import libp2p are not enough on their own: npm places a package
// from the first dependent it processes, in install-path order, so a caret range
// on another @libp2p/* package would install the newest release next to ours.
// The package nodes install (the CLI) therefore pins every family package in
// the lockfile; npm processes it before anything below it.
import { parse } from 'yaml';

export const LIBP2P_FAMILY = /^(libp2p|@libp2p\/[^/]+|@chainsafe\/[^/]+|@multiformats\/[^/]+|retimeable-signal)$/;
export const INSTALL_ROOT_PACKAGE = '@origintrail-official/dkg';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Family package name -> versions in the lockfile's `packages` section. */
export function lockfileFamilyVersions(lockText) {
  const versions = new Map();
  for (const key of Object.keys(parse(lockText)?.packages ?? {})) {
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    if (!LIBP2P_FAMILY.test(name)) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(key.slice(at + 1));
  }
  return versions;
}

/**
 * One message per violation. `manifests` are the published packages'
 * package.json objects; `lockVersions` comes from lockfileFamilyVersions.
 */
export function findLibp2pPinViolations({ manifests, lockVersions }) {
  const violations = [];
  for (const [name, versions] of lockVersions) {
    if (versions.size > 1) violations.push(`pnpm-lock.yaml has ${name} at ${[...versions].sort().join(', ')}: an npm install would mix versions; keep one`);
  }
  for (const manifest of manifests) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!LIBP2P_FAMILY.test(name)) continue;
        const locked = [...(lockVersions.get(name) ?? [])];
        if (!EXACT_VERSION.test(spec)) violations.push(`${manifest.name} ${field}: ${name} is "${spec}"; use the exact version from pnpm-lock.yaml (${locked.join(', ') || 'not locked'})`);
        else if (!locked.includes(spec)) violations.push(`${manifest.name} ${field}: ${name} is ${spec} but pnpm-lock.yaml has ${locked.join(', ') || 'none'}`);
      }
    }
  }
  const root = manifests.find((manifest) => manifest.name === INSTALL_ROOT_PACKAGE);
  if (!root) violations.push(`${INSTALL_ROOT_PACKAGE} is not among the published packages`);
  else {
    for (const name of [...lockVersions.keys()].sort()) {
      if (root.dependencies?.[name] === undefined) violations.push(`${INSTALL_ROOT_PACKAGE} dependencies: add ${name} ${[...lockVersions.get(name)].join(', ')}; npm installs take the libp2p family's versions from it`);
    }
  }
  return violations;
}
