import type { ResolvedAutoUpdateConfig } from './config.js';

export interface AutoUpdateGitRefPlan {
  ref: string;
  tagName: string | null;
  verifyTagSignature: boolean;
  shouldVerifyTagSignature: boolean;
  fetchRef: string;
}

export function parseTagName(ref: string): string | null {
  const m = ref.match(/^refs\/tags\/(.+)$/);
  return m ? m[1] : null;
}

export function normalizeAutoUpdateVerifyTagSignature(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true;
}

export function isValidRef(ref: string): boolean {
  if (!/^[\w./+\-]+$/.test(ref)) return false;
  if (!ref || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  if (ref.endsWith(".")) return false;
  const parts = ref.split("/");
  return parts.every((part) => {
    if (!part || part === "." || part === "..") return false;
    if (part.endsWith(".lock")) return false;
    return true;
  });
}

export function normalizeGitRefInput(ref: string): string {
  const trimmed = ref.trim() || "main";
  if (!isValidRef(trimmed)) {
    throw new Error(`invalid branch/ref "${ref}"`);
  }
  if (trimmed.startsWith("refs/")) return trimmed;
  return `refs/heads/${trimmed}`;
}

export function resolveAutoUpdateGitRef(
  au: Pick<ResolvedAutoUpdateConfig, "branch"> & { ref?: string },
  refOverride?: string,
): string {
  return normalizeGitRefInput(refOverride ?? au.ref ?? au.branch);
}

export function resolveAutoUpdateGitRefPlan(
  au: Pick<ResolvedAutoUpdateConfig, "branch"> & { ref?: string; verifyTagSignature?: unknown },
  opts: { refOverride?: string; verifyTagSignature?: unknown } = {},
): AutoUpdateGitRefPlan {
  const ref = resolveAutoUpdateGitRef(au, opts.refOverride);
  const overrideHasVerify = Object.prototype.hasOwnProperty.call(opts, 'verifyTagSignature');
  const verifyTagSignature = (
    overrideHasVerify
      ? normalizeAutoUpdateVerifyTagSignature(opts.verifyTagSignature)
      : normalizeAutoUpdateVerifyTagSignature(au.verifyTagSignature)
  ) ?? false;
  const tagName = parseTagName(ref);
  const shouldVerifyTagSignature = Boolean(tagName && verifyTagSignature);
  return {
    ref,
    tagName,
    verifyTagSignature,
    shouldVerifyTagSignature,
    fetchRef: shouldVerifyTagSignature ? `+${ref}:${ref}` : ref,
  };
}

export function formatAutoUpdateTagVerificationWarning(plan: AutoUpdateGitRefPlan): string | null {
  if (!plan.verifyTagSignature || plan.tagName) return null;
  return `Auto-update (git): WARNING verifyTagSignature=true is inert for non-tag ref "${plan.ref}". ` +
    'Git tag-signature verification only applies to refs/tags/*; use a signed tag ref or disable verifyTagSignature.';
}
