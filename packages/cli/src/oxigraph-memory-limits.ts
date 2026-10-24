export interface OxigraphMemoryLimits {
  highMiB?: number;
  maxMiB: number;
}

/** Shared preflight/launch policy; checking systemd availability remains a launch concern. */
export function oxigraphMemorySupportError(
  input: { highMiB?: unknown; maxMiB?: unknown },
  platform: NodeJS.Platform,
): string | undefined {
  if ((input.highMiB !== undefined || input.maxMiB !== undefined) && platform !== 'linux') {
    return `Managed Oxigraph memory limits require Linux with a running systemd user manager (unsupported on ${platform}). `
      + 'Remove memoryHighMiB/memoryMaxMiB or run the managed store on Linux.';
  }
  return undefined;
}

export function normalizeOxigraphMemoryLimits(input: {
  highMiB?: unknown;
  maxMiB?: unknown;
}): OxigraphMemoryLimits | undefined {
  if (input.highMiB === undefined && input.maxMiB === undefined) return undefined;
  if (typeof input.maxMiB !== 'number' || !Number.isSafeInteger(input.maxMiB) || input.maxMiB <= 0) {
    throw new Error('Managed Oxigraph memoryMaxMiB must be a positive integer');
  }
  if (
    input.highMiB !== undefined &&
    (typeof input.highMiB !== 'number' || !Number.isSafeInteger(input.highMiB) || input.highMiB <= 0 || input.highMiB > input.maxMiB)
  ) {
    throw new Error('Managed Oxigraph memoryHighMiB must be a positive integer no greater than memoryMaxMiB');
  }
  return {
    maxMiB: input.maxMiB,
    ...(typeof input.highMiB === 'number' ? { highMiB: input.highMiB } : {}),
  };
}
