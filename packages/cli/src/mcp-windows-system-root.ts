/** Resolve the Windows installation without searching the working directory or PATH. */
export function windowsSystemRoot(): string {
  // WSL may not inherit SystemRoot; preserve the existing explicit override and fallback.
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  if (!/^[A-Za-z]:[\\/]/.test(root) || /[\\/]\.\.?([\\/]|$)/.test(root)) {
    throw new Error('MCP requires an absolute Windows SystemRoot (for example C:\\Windows).');
  }
  return root;
}
