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
  // Optional per the registry schema, and genuinely optional here: a server
  // launched by a binary already on PATH needs none, so installMcp normalises
  // a missing value to `args: []` rather than refusing the entry. Judging
  // whether a given command needs arguments is the entry author's call.
  args?: string[];
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
  runtime: 'docker' | 'npm-global' | 'binary';
  docker?: {
    image: string;
    digest?: string;
    ports?: Array<{ container: number; host?: number }>;
    env?: Record<string, string>;
  };
  npmGlobal?: {
    package: string;
    version: string;
    // Optional in the registry schema (only package + version are required),
    // and genuinely optional here: an entry whose binary name matches its
    // package name omits it. `resolveBinary` in install-service.ts is the
    // single normalization point that falls back to the package name — the
    // type must not claim a guarantee the registry does not make.
    binary?: string;
    env?: Record<string, string>;
  };
  // Named `binary` to match the registry schema exactly. A maintainer
  // implementing runtime: 'binary' reads entry.install.binary.url from a real
  // entry, so the type must not invent a different name for it.
  binary?: {
    url: string;
    checksumSha256?: string;
  };
  // Present in the registry schema; surfaced in post-install guidance.
  envRequired?: string[];
  portsOpened?: number[];
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
  // The registry schema requires docsUrl and allows only oneLiner beyond it
  // (additionalProperties: false). `manual` means the installer links out to
  // the integration's own docs rather than automating anything.
  docsUrl: string;
  oneLiner?: string;
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

// INVARIANT: this must never be STRICTER than the registry's published JSON
// Schema (https://origintrail.io/schemas/integration/v0.1.0.json, $defs.install*).
// It may be more lenient — unknown fields and unknown enum values must ride
// through so an older CLI can still read a newer registry — but every entry the
// registry can merge has to parse here, or `dkg integration` and the dashboard
// sidebar silently drop it as "unreadable". Three divergences did exactly that:
// `manual` required a `steps` field the schema forbids, `mcp` required the
// schema-optional `args`, and `service` rejected the schema's `binary` runtime.
// Requirements that make an entry *installable* (rather than readable) belong in
// the installers, not here — see installMcp's args check.
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
      // `args` is optional per the schema. An entry without it is readable but
      // not installable; installMcp refuses it rather than emitting a config
      // with no launch arguments.
      return (
        typeof v.command === 'string' &&
        (v.args === undefined || isStringArray(v.args)) &&
        (v.envRequired === undefined || isStringArray(v.envRequired)) &&
        (v.supportedClients === undefined || isStringArray(v.supportedClients))
      );
    case 'service':
      return v.runtime === 'docker' || v.runtime === 'npm-global' || v.runtime === 'binary';
    case 'agent-plugin':
      return (
        typeof v.framework === 'string' &&
        typeof v.package === 'string' &&
        typeof v.version === 'string'
      );
    case 'manual':
      // The schema requires docsUrl and forbids anything else beyond oneLiner;
      // `manual` means "the installer links out to your docs" (CONTRIBUTING §2).
      return (
        typeof v.docsUrl === 'string' &&
        (v.oneLiner === undefined || typeof v.oneLiner === 'string')
      );
    default:
      return false;
  }
}

