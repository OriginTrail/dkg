import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** Decode execution_data with the dependency belonging to the selected n8n installation. */
export function nativeExecutionParser(args = process.argv.slice(2)) {
  const index = args.indexOf('--n8n-package'), file = index < 0 ? undefined : args[index + 1];
  if (!file || file.startsWith('--')) throw new Error('Supply --n8n-package /path/to/n8n/package.json for native verification.');
  const packageFile = resolve(file);
  if (JSON.parse(readFileSync(packageFile, 'utf8')).name !== 'n8n') throw new Error('--n8n-package must select the installed n8n package.json.');
  const { parse } = createRequire(packageFile)('flatted');
  if (typeof parse !== 'function') throw new Error('The selected n8n installation has no flatted parser.');
  return parse;
}
