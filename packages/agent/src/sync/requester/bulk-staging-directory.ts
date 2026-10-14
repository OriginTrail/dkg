import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Every chunk owns at most 16 MiB. Eight atomic directory reservations bound
// active plus failed staging to 128 MiB and bound empty failed diagnostics too.
// A full root refuses new work, preserving all prior evidence for the operator.
const MAX_DIRECTORIES = 8;
export async function reserveBulkStagingDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await readdir(root);
  // Older/random chunk directories and unknown entries consume capacity too.
  const legacy = entries.filter(name => !/^chunk-slot-[0-7]$/.test(name)).length;
  for (let slot = 0; slot < MAX_DIRECTORIES - legacy; slot++) {
    const directory = join(root, `chunk-slot-${slot}`);
    try {
      await mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw Object.assign(new Error('Bulk staging retention capacity exhausted'), { code: 'RESOURCE_LIMIT' });
}
