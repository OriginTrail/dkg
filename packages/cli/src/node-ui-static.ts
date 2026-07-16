import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_NODE_UI_PACKAGE_NAME = '@origintrail-official/dkg-node-ui';
export const LEGACY_NODE_UI_PACKAGE_NAME = '@dkg/node-ui';
export const NODE_UI_PACKAGE_NAME_FALLBACKS = [
  DEFAULT_NODE_UI_PACKAGE_NAME,
  LEGACY_NODE_UI_PACKAGE_NAME,
];

export const NODE_UI_STATIC_BUILD_COMMAND = nodeUiStaticBuildCommand();

export const NODE_UI_STATIC_BUILD_LABEL = nodeUiStaticBuildLabel();

export const RUNTIME_PACKAGES_BUILD_COMMAND = 'pnpm build:runtime:packages';
export const RUNTIME_BUILD_COMMAND = 'pnpm build:runtime';
export const FULL_BUILD_COMMAND = 'pnpm build';
export const RELEASE_RUNTIME_BUILD_SCRIPT = 'releaseRuntimeBuildScript';

export function runtimeBuildCommandFromPackageJson(raw: string): string {
  try {
    const rootPkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dkgBuild?: Record<string, unknown>;
    };
    const releaseRuntimeBuildScript = rootPkg.dkgBuild?.[RELEASE_RUNTIME_BUILD_SCRIPT];
    const runtimePackagesScript = rootPkg.scripts?.['build:runtime:packages'];
    const runtimeScript = rootPkg.scripts?.['build:runtime'];
    if (
      typeof releaseRuntimeBuildScript === 'string' &&
      isSafePnpmScriptName(releaseRuntimeBuildScript) &&
      typeof rootPkg.scripts?.[releaseRuntimeBuildScript] === 'string'
    ) {
      return `pnpm ${releaseRuntimeBuildScript}`;
    }
    if (typeof runtimeScript === 'string') {
      return RUNTIME_BUILD_COMMAND;
    }
    if (typeof runtimePackagesScript === 'string') {
      return RUNTIME_PACKAGES_BUILD_COMMAND;
    }
  } catch {
    // Fall through to the broad build command when metadata is unreadable.
  }
  return FULL_BUILD_COMMAND;
}

function isSafePnpmScriptName(scriptName: string): boolean {
  return /^[A-Za-z0-9:_-]+$/.test(scriptName);
}

export function nodeUiPackageJsonPath(slotDir: string): string {
  return join(slotDir, 'packages', 'node-ui', 'package.json');
}

export function nodeUiStaticDistPath(slotDir: string): string {
  return join(slotDir, 'packages', 'node-ui', 'dist-ui');
}

export function nodeUiStaticIndexPath(slotDir: string): string {
  return join(nodeUiStaticDistPath(slotDir), 'index.html');
}

export function nodeUiStaticIndexPaths(slotDir: string): string[] {
  return [
    nodeUiStaticIndexPath(slotDir),
    ...nodeUiNpmStaticIndexPaths(slotDir),
  ];
}

export function nodeUiNpmStaticIndexPaths(
  slotDir: string,
  packageNames = NODE_UI_PACKAGE_NAME_FALLBACKS,
): string[] {
  return packageNames.flatMap((packageName) => {
    const packagePath = packageName.split('/');
    return [
      join(slotDir, 'node_modules', ...packagePath, 'dist-ui', 'index.html'),
      join(
        slotDir,
        'node_modules',
        '@origintrail-official',
        'dkg',
        'node_modules',
        ...packagePath,
        'dist-ui',
        'index.html',
      ),
    ];
  });
}

export function isNodeUiGitLayoutSlot(
  slotDir: string,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  return pathExists(nodeUiPackageJsonPath(slotDir))
    || pathExists(join(slotDir, 'packages', 'cli', 'dist', 'cli.js'));
}

export function nodeUiStaticBuildCommand(
  packageName = DEFAULT_NODE_UI_PACKAGE_NAME,
): string {
  return `pnpm --filter ${packageName} run build:ui`;
}

export function nodeUiStaticBuildLabel(
  packageName = DEFAULT_NODE_UI_PACKAGE_NAME,
): string {
  return `pnpm --filter ${packageName} build:ui`;
}

export function nodeUiPackageNameFromPackageJson(raw: string): string {
  try {
    const name = String((JSON.parse(raw) as { name?: unknown }).name ?? '').trim();
    return name || DEFAULT_NODE_UI_PACKAGE_NAME;
  } catch {
    return DEFAULT_NODE_UI_PACKAGE_NAME;
  }
}

export function nodeUiPackageNamesFromCliPackageJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    const dependencySets = [
      parsed.dependencies,
      parsed.optionalDependencies,
      parsed.peerDependencies,
    ];
    const declared = NODE_UI_PACKAGE_NAME_FALLBACKS.filter((packageName) =>
      dependencySets.some((deps) =>
        deps && Object.prototype.hasOwnProperty.call(deps, packageName),
      ),
    );
    return declared.length > 0 ? declared : NODE_UI_PACKAGE_NAME_FALLBACKS;
  } catch {
    return NODE_UI_PACKAGE_NAME_FALLBACKS;
  }
}
