// TypeScript shape of a DKG integration registry entry.
//
// Mirrors schema/integration.schema.json in OriginTrail/dkg-integrations. Only
// the fields the CLI actually consumes are typed strongly; the rest ride in
// `[unknownExtras: string]: unknown` so a schema bump in the registry doesn't
// break the CLI without a corresponding code change here.

export type TrustTier = 'community' | 'verified' | 'featured';
export type MemoryLayer = 'WM' | 'SWM' | 'VM';
export type PublicInterface = 'http-api' | 'cli' | 'mcp';

export type InstallSpec =
  | InstallCli
  | InstallMcp
  | InstallService
  | InstallAgentPlugin
  | InstallManual;

export interface InstallCli {
  kind: 'cli';
  package: string;
  version: string;
  binary: string;
  envRequired?: string[];
  usageHint?: string;
}

export interface InstallMcp {
  kind: 'mcp';
  command: string;
  args: string[];
  // Env var NAMES the MCP server expects. Per the registry schema,
  // DKG_AUTH_TOKEN and DKG_API_URL are auto-filled by the installer when
  // listed here; other names are rendered as placeholders the user must
  // fill in. Entries that DO NOT list DKG_AUTH_TOKEN never get the
  // local admin token injected — that's the security boundary.
  envRequired?: string[];
  supportedClients?: string[];
  usageHint?: string;
}

export interface InstallService {
  kind: 'service';
  runtime: 'docker' | 'npm-global';
  docker?: {
    image: string;
    digest?: string;
    ports?: Array<{ container: number; host?: number }>;
    env?: Record<string, string>;
  };
  npmGlobal?: {
    package: string;
    version: string;
    binary: string;
    env?: Record<string, string>;
  };
  usageHint?: string;
}

export interface InstallAgentPlugin {
  kind: 'agent-plugin';
  framework: string;
  package: string;
  version: string;
  registrationHint?: string;
  usageHint?: string;
}

export interface InstallManual {
  kind: 'manual';
  steps: string[];
  usageHint?: string;
}

export interface IntegrationEntry {
  slug: string;
  name: string;
  description: string;
  category?: string[];
  maintainer: { github: string; name?: string; email?: string };
  repo: string;
  commit: string;
  license: string;
  schemaVersion?: string;
  requiresDkgNodeVersion?: string;
  memoryLayers: MemoryLayer[];
  v10PrimitivesUsed: string[];
  publicInterfacesUsed: PublicInterface[];
  targetAgents?: string[];
  install: InstallSpec;
  security: {
    networkEgress?: string[];
    writeAuthority?: string[];
    credentialsHandled?: string[];
    notes?: string;
  };
  trustTier: TrustTier;
  designBrief?: string;
  demo?: string;
  promotionPath?: string;
  fitNotes?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extras: string]: any;
}

// Validates the full shape the CLI consumes from a registry entry. The list /
// info / install paths dereference nested fields like security.writeAuthority,
// maintainer.github, memoryLayers, and install-kind-specific args; a loose
// check here would just move the failure site to a confusing later throw. If
// the registry ever adds new fields, they ride through on `[extras]: any` —
// but the fields the CLI reads today must be present and the right shape.
export function isIntegrationEntry(value: unknown): value is IntegrationEntry {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;

  // Required scalar fields.
  if (typeof o.slug !== 'string') return false;
  if (typeof o.name !== 'string') return false;
  if (typeof o.description !== 'string') return false;
  if (typeof o.repo !== 'string') return false;
  if (typeof o.commit !== 'string') return false;
  if (typeof o.license !== 'string') return false;

  // Maintainer: must have a GitHub handle (used in `info` output + UI).
  if (!isPlainObject(o.maintainer)) return false;
  if (typeof (o.maintainer as Record<string, unknown>).github !== 'string') return false;

  // Memory layers / primitives / interfaces: we render them and, for layers,
  // filter for display. Must be string arrays with known values where we care.
  if (!isStringArray(o.memoryLayers)) return false;
  for (const m of o.memoryLayers as unknown[]) {
    if (m !== 'WM' && m !== 'SWM' && m !== 'VM') return false;
  }
  if (!isStringArray(o.v10PrimitivesUsed)) return false;
  // publicInterfacesUsed is rendered but not dispatched on, so accept any
  // string here. Hard-rejecting unknown values would stop older CLIs from
  // reading otherwise-valid registry entries as soon as the registry adds a
  // new interface label — forward-compat beats strictness for display-only
  // fields. trustTier, memoryLayers, and install.kind stay strict below
  // because the CLI branches on them.
  if (!isStringArray(o.publicInterfacesUsed)) return false;

  // Trust tier: direct input to the `--allow-community` gate.
  if (o.trustTier !== 'community' && o.trustTier !== 'verified' && o.trustTier !== 'featured') {
    return false;
  }

  // Security declaration: `info` always prints it; must be an object.
  if (!isPlainObject(o.security)) return false;
  const sec = o.security as Record<string, unknown>;
  if (sec.networkEgress !== undefined && !isStringArray(sec.networkEgress)) return false;
  if (sec.writeAuthority !== undefined && !isStringArray(sec.writeAuthority)) return false;
  if (sec.credentialsHandled !== undefined && !isStringArray(sec.credentialsHandled)) return false;
  if (sec.notes !== undefined && typeof sec.notes !== 'string') return false;

  // Install spec: dispatcher and kind-specific fields the installers read.
  if (!isValidInstallSpec(o.install)) return false;

  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isValidInstallSpec(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const kind = v.kind;
  switch (kind) {
    case 'cli':
      return (
        typeof v.package === 'string' &&
        typeof v.version === 'string' &&
        typeof v.binary === 'string' &&
        (v.envRequired === undefined || isStringArray(v.envRequired)) &&
        (v.usageHint === undefined || typeof v.usageHint === 'string')
      );
    case 'mcp':
      return (
        typeof v.command === 'string' &&
        isStringArray(v.args) &&
        (v.envRequired === undefined || isStringArray(v.envRequired)) &&
        (v.supportedClients === undefined || isStringArray(v.supportedClients))
      );
    case 'service':
      return v.runtime === 'docker' || v.runtime === 'npm-global';
    case 'agent-plugin':
      return (
        typeof v.framework === 'string' &&
        typeof v.package === 'string' &&
        typeof v.version === 'string'
      );
    case 'manual':
      return isStringArray(v.steps);
    default:
      return false;
  }
}

