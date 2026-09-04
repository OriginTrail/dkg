/**
 * §4.7.2 Check: configuration sanity.
 *
 * Validates `~/.dkg/config.json` against an opportunistic schema +
 * semantic constraints. Reports:
 *   - Deprecated fields set to non-empty values (warnings).
 *   - Semantic violations (e.g. `apiPort` out of range) (errors).
 *   - `nodeRole` not in `{ "edge", "core" }` (error).
 *   - Missing config file (warning — the daemon will use defaults
 *     but `dkg init` was never run).
 *
 * We deliberately don't enumerate "unknown top-level fields" — DKG's
 * config surface evolves rapidly and a strict-schema check would
 * produce false positives on every release. The schema-evolution
 * cost-benefit is documented in OT-RFC-41 §4.7.2.
 */
import { join } from 'node:path';
import {
  AUTO_UPDATE_GIT_ONLY_FIELDS,
  validateStoreConfig,
  parseAutoUpdateVerifyTagSignature,
  type DkgConfig,
} from '../../config.js';
import { resolveMetricsCollectorConfig } from '../../metrics-collector-config.js';
import {
  formatAutoUpdateTagVerificationWarning,
  resolveAutoUpdateGitRefPlan,
} from '../../auto-update-ref.js';
import type { DoctorDeps, Finding } from '../types.js';

export async function runConfigSanityCheck(deps: DoctorDeps): Promise<Finding[]> {
  const findings: Finding[] = [];
  const configPath = join(deps.dkgHome, 'config.json');

  if (!deps.exists(configPath)) {
    findings.push({
      check: 'config-sanity',
      severity: 'warning',
      message: `No config file at ${configPath}`,
      advisory: "Run 'dkg init' to bootstrap the node config. The daemon will start with defaults until you do.",
      subject: configPath,
    });
    return findings;
  }

  const raw = await deps.readFile(configPath);
  if (raw === null) {
    findings.push({
      check: 'config-sanity',
      severity: 'error',
      message: `Config file exists but is unreadable: ${configPath}`,
      advisory: 'Check file permissions. The daemon will fail to start if this persists.',
      subject: configPath,
    });
    return findings;
  }

  let parsed: Record<string, unknown>;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('config.json is not a JSON object');
    }
    parsed = obj as Record<string, unknown>;
  } catch (err: any) {
    findings.push({
      check: 'config-sanity',
      severity: 'error',
      message: `Config file is malformed JSON: ${configPath}`,
      advisory: `Fix or restore the file: ${err?.message ?? err}. The daemon will refuse to start until JSON parses cleanly.`,
      subject: configPath,
    });
    return findings;
  }

  for (const error of validateStoreConfig(parsed as unknown as DkgConfig, deps.platform)) {
    findings.push({ check: 'config-sanity', severity: 'error', message: error.message, subject: error.field });
  }

  // nodeRole sanity
  const nodeRole = parsed.nodeRole;
  if (nodeRole !== undefined && nodeRole !== 'edge' && nodeRole !== 'core') {
    findings.push({
      check: 'config-sanity',
      severity: 'error',
      message: `Invalid nodeRole in config: ${JSON.stringify(nodeRole)}`,
      advisory: "Set 'nodeRole' to 'edge' (default, for laptops/personal use) or 'core' (24/7 relay/SLA).",
      subject: 'nodeRole',
    });
  }

  // apiPort sanity
  const apiPort = parsed.apiPort;
  if (apiPort !== undefined) {
    const n = typeof apiPort === 'number' ? apiPort : Number(apiPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      findings.push({
        check: 'config-sanity',
        severity: 'error',
        message: `apiPort out of range: ${JSON.stringify(apiPort)}`,
        advisory: 'Pick a port in the 1024-65535 range (1-1023 require root). Default is 9200.',
        subject: 'apiPort',
      });
    }
  }

  const telemetry = parsed.telemetry;
  if (telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)) {
    const metrics = (telemetry as Record<string, unknown>).metrics;
    if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
      const collectionEnabled = (metrics as Record<string, unknown>).collectionEnabled;
      if (collectionEnabled !== undefined) {
        try {
          resolveMetricsCollectorConfig({
            telemetry: { metrics: { collectionEnabled } },
          } as unknown as Pick<DkgConfig, 'telemetry'>, {});
        } catch (err) {
          findings.push({
            check: 'config-sanity',
            severity: 'error',
            message: err instanceof Error ? err.message : String(err),
            advisory: 'Set telemetry.metrics.collectionEnabled to true or false.',
            subject: 'telemetry.metrics.collectionEnabled',
          });
        }
      }
    }
  }

  // autoUpdate sub-config
  const autoUpdate = parsed.autoUpdate;
  if (autoUpdate && typeof autoUpdate === 'object' && !Array.isArray(autoUpdate)) {
    const au = autoUpdate as Record<string, unknown>;
    const source = au.source;
    const gitMode = source === 'git';

    for (const field of AUTO_UPDATE_GIT_ONLY_FIELDS) {
      if (gitMode) continue;
      const value = au[field];
      if (value === undefined || value === null || value === '') continue;
      findings.push({
        check: 'config-sanity',
        severity: 'warning',
        message: `Deprecated autoUpdate field is set: autoUpdate.${field}`,
        advisory: `The '${field}' field is inert unless autoUpdate.source is 'git'. Remove it from npm-mode ~/.dkg/config.json — the daemon will continue to ignore it, but its presence is misleading to anyone reading the file.`,
        subject: `autoUpdate.${field}`,
      });
    }

    if (gitMode) {
      let verificationWarning: string | null = null;
      const parsedVerifyTagSignature = parseAutoUpdateVerifyTagSignature(au.verifyTagSignature);
      if (parsedVerifyTagSignature.error) {
        findings.push({
          check: 'config-sanity',
          severity: 'error',
          message: parsedVerifyTagSignature.error,
          advisory: 'Set autoUpdate.verifyTagSignature to true or false, or remove it to inherit the network default.',
          subject: 'autoUpdate.verifyTagSignature',
        });
      }
      try {
        const refPlan = resolveAutoUpdateGitRefPlan({
          branch: typeof au.branch === 'string' ? au.branch : 'main',
          ...(typeof au.ref === 'string' ? { ref: au.ref } : {}),
          ...(parsedVerifyTagSignature.value !== undefined
            ? { verifyTagSignature: parsedVerifyTagSignature.value }
            : {}),
        });
        verificationWarning = formatAutoUpdateTagVerificationWarning(refPlan);
      } catch {
        verificationWarning = null;
      }
      if (verificationWarning) {
        findings.push({
          check: 'config-sanity',
          severity: 'warning',
          message: verificationWarning.replace(/^Auto-update \(git\): WARNING /, ''),
          advisory: "Git tag-signature verification only applies to refs/tags/*. Set autoUpdate.ref to a signed tag ref, or set verifyTagSignature to false so the config does not imply branch updates are signature-verified.",
          subject: 'autoUpdate.verifyTagSignature',
        });
      }
    }

    const checkIntervalMinutes = au.checkIntervalMinutes;
    if (checkIntervalMinutes !== undefined) {
      const n = typeof checkIntervalMinutes === 'number' ? checkIntervalMinutes : Number(checkIntervalMinutes);
      if (!Number.isFinite(n) || n < 1) {
        findings.push({
          check: 'config-sanity',
          severity: 'error',
          message: `autoUpdate.checkIntervalMinutes < 1: ${JSON.stringify(checkIntervalMinutes)}`,
          advisory: 'Set autoUpdate.checkIntervalMinutes to an integer ≥ 1 (default 30).',
          subject: 'autoUpdate.checkIntervalMinutes',
        });
      }
    }

    if (source !== undefined && source !== 'npm' && source !== 'monorepo' && source !== 'git' && source !== 'auto') {
      findings.push({
        check: 'config-sanity',
        severity: 'warning',
        message: `autoUpdate.source has an unknown value: ${JSON.stringify(source)}`,
        advisory: "Expected 'npm' (recommended default), 'git' (advanced Core-node git updater), or 'monorepo' (for contributor checkouts). Older value 'auto' is accepted for compatibility.",
        subject: 'autoUpdate.source',
      });
    }
  }

  return findings;
}
