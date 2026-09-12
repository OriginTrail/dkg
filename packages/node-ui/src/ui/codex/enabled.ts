export const codexEnabled = typeof window !== 'undefined' && Boolean((window as Window & { __DKG_CODEX__?: boolean }).__DKG_CODEX__);
