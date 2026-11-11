export const studioRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const bounded = (v: unknown, max = 8192): v is string =>
  typeof v === 'string' && v.length <= max;
export const programIri = (v: unknown): v is string =>
  bounded(v, 240) && /^[a-z][a-z0-9+.-]*:[^\s<>"{}\\]+$/i.test(v);
export const blockId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(v);
export const studioUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export const invalid = (): never => {
  throw new Error('The Studio response or recovery data could not be verified.');
};
