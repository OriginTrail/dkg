import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CONFIG = 'claude_desktop_config.json';

/** Classic and relocated Windows installs share one logical Claude Desktop target. */
export function claudeDesktopConfigPaths(classic: string, localAppData: string | null): {
  configPaths: string[];
  checkedPaths: string[];
} {
  const candidates = [classic];
  const relocatedRoot = localAppData && join(localAppData, 'Claude-Data');
  const checkedPaths = [classic];
  if (relocatedRoot) {
    checkedPaths.push(join(relocatedRoot, 'claude_*', CONFIG));
    try {
      for (const entry of readdirSync(relocatedRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^claude_[\w-]+$/.test(entry.name)) candidates.push(join(relocatedRoot, entry.name, CONFIG));
      }
    } catch { /* An absent or unreadable relocated root leaves classic detection available. */ }
  }
  const existing = candidates.flatMap((configPath) => {
    try {
      const stat = statSync(configPath);
      return stat.isFile() ? [{ configPath, modified: stat.mtimeMs }] : [];
    } catch { return []; }
  });
  // Prefer a real config over an empty directory, then the most recently modified
  // config. The path tie-break makes equal timestamps independent of readdir order.
  existing.sort((a, b) => b.modified - a.modified || a.configPath.localeCompare(b.configPath));
  const preferred = existing[0]?.configPath ?? candidates.find((candidate) => existsSync(dirname(candidate))) ?? classic;
  return {
    configPaths: [preferred, ...candidates.filter((candidate) => candidate !== preferred)],
    checkedPaths,
  };
}
