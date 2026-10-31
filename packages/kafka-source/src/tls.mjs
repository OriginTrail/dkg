import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function kafkaTls(source) {
  if (source.ssl !== undefined && typeof source.ssl !== 'boolean') throw new Error('KAFKA_TLS_REFS_INVALID');
  const fields = ['caFileEnv', 'certFileEnv', 'keyFileEnv'];
  if (!!source.certFileEnv !== !!source.keyFileEnv || (source.ssl === false && fields.some(k => source[k])))
    throw new Error('KAFKA_TLS_REFS_INVALID');
  if (!fields.some(k => source[k])) return source.ssl ?? true;
  const ssl = { rejectUnauthorized: true };
  for (const [field, option] of [['caFileEnv', 'ca'], ['certFileEnv', 'cert'], ['keyFileEnv', 'key']]) {
    if (!source[field]) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source[field])) throw new Error('KAFKA_TLS_REFS_INVALID');
    const path = process.env[source[field]];
    if (!path || !isAbsolute(path)) throw new Error('KAFKA_TLS_FILE_REQUIRED');
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 65536 ||
        (option === 'key' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('invalid');
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('changed');
      ssl[option] = bytes.subarray(0, bytesRead).toString('utf8');
    } catch { throw new Error('KAFKA_TLS_FILE_INVALID'); }
    finally { await file?.close(); }
  }
  return ssl;
}
