import type { ResolvedAutoUpdateConfig } from './config.js';

export function parseTagName(ref: string): string | null {
  const m = ref.match(/^refs\/tags\/(.+)$/);
  return m ? m[1] : null;
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
