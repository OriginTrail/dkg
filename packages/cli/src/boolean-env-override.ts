export interface BooleanEnvOverrideOptions {
  /** The environment variable's name, for the error message. */
  envName: string;
  /** The config key's name, for the error message. */
  configName: string;
  envValue: string | undefined;
  configValue: unknown;
  /** Used when neither the environment nor the config sets the flag. */
  defaultValue: boolean;
}

/**
 * The one rule behind every daemon boolean flag whose environment variable
 * overrides its config key:
 *
 * - a SET environment variable wins and must read 1, 0, true or false (case
 *   and surrounding whitespace ignored). Anything else, the empty string
 *   included, throws so startup fails instead of silently picking a side;
 * - otherwise a config value must be a boolean;
 * - otherwise `defaultValue`.
 */
export function resolveBooleanEnvOverride(options: BooleanEnvOverrideOptions): boolean {
  const { envName, configName, envValue, configValue, defaultValue } = options;
  if (envValue !== undefined) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    throw new Error(
      `${envName} must be one of 1, 0, true, or false (received ${JSON.stringify(envValue)})`,
    );
  }
  if (configValue === undefined) return defaultValue;
  if (typeof configValue !== 'boolean') {
    throw new Error(`${configName} must be a boolean (received ${JSON.stringify(configValue)})`);
  }
  return configValue;
}
