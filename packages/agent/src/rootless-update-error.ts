export const ROOTLESS_UPDATE_ERROR_CODES = [
  'ROOTLESS_UPDATE_INVALID_KA_ID',
  'ROOTLESS_KA_NOT_MATERIALIZED',
  'ROOTLESS_UPDATE_TARGET_CORRUPT',
  'ROOTLESS_UPDATE_TARGET_NOT_CONFIRMED',
] as const;

export type RootlessUpdateErrorCode = typeof ROOTLESS_UPDATE_ERROR_CODES[number];

const ROOTLESS_UPDATE_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  ROOTLESS_UPDATE_ERROR_CODES,
);

export class RootlessUpdateError extends Error {
  readonly code: RootlessUpdateErrorCode;

  constructor(code: RootlessUpdateErrorCode, message: string) {
    super(message);
    this.name = 'RootlessUpdateError';
    this.code = code;
  }
}

/** Closed structural guard for errors crossing the agent/CLI package boundary. */
export function isRootlessUpdateError(error: unknown): error is RootlessUpdateError {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' && ROOTLESS_UPDATE_ERROR_CODE_SET.has(code);
}
