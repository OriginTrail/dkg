/** Internal launch policy; never persisted as a client configuration field. */
export interface WslEnvironmentTransfer {
  kind: 'windows-wsl';
  inherited: string;
}

/** Preserve explicit WSLENV translation flags while enabling configured Windows inputs. */
export function forwardedWslEnvironment(env: Record<string, unknown>, inherited: string): string {
  const configured = env.WSLENV ?? inherited;
  if (typeof configured !== 'string') throw new Error('MCP WSLENV must be a string.');
  const names = Object.keys(env).filter(name => name !== 'WSLENV').sort();
  if (names.some(name => /[:/=\p{Cc}]/u.test(name))) {
    throw new Error('MCP environment variable names cannot contain WSLENV separators or control characters.');
  }
  const remaining = new Set(names);
  const entries = configured.split(':').filter(Boolean).map(entry => {
    const [name, flags = ''] = entry.split('/');
    if (!names.includes(name!)) return entry;
    remaining.delete(name!);
    // /w alone excludes Windows→WSL, contradicting this explicit server setting.
    // Preserve path/list and other direction flags already requested by the user.
    const compatible = flags.replaceAll('w', '');
    return compatible ? `${name}/${compatible}` : name!;
  });
  return [...entries, ...[...remaining].map(name => `${name}/u`)].join(':');
}
