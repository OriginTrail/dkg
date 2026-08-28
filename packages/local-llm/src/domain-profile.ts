export interface DkgLocalLlmDomainProfile {
  name: string;
  description?: string;
  routingKeywords: string[];
  readTools: string[];
  writeTools?: string[];
  systemContext?: string;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

function stringField(record: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = record[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Domain profile '${key}' must be a non-empty string.`);
  return value.trim();
}

function stringList(
  record: Record<string, unknown>,
  key: string,
  options: { required?: boolean; toolNames?: boolean } = {},
): string[] {
  const value = record[key];
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value) || (options.required && value.length === 0)) {
    throw new Error(`Domain profile '${key}' must be a${options.required ? ' non-empty' : ''} string array.`);
  }
  if (value.length > 64) throw new Error(`Domain profile '${key}' allows at most 64 entries.`);
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`Domain profile '${key}' must contain only non-empty strings.`);
    }
    const normalized = entry.trim();
    if (normalized.length > 128) throw new Error(`Domain profile '${key}' entries must be at most 128 characters.`);
    if (options.toolNames && !TOOL_NAME.test(normalized)) {
      throw new Error(`Domain profile '${key}' contains an invalid MCP tool name: ${normalized}`);
    }
    return normalized;
  });
  return [...new Set(entries)];
}

export function parseDomainProfile(value: unknown): DkgLocalLlmDomainProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Domain profile must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const systemContext = stringField(record, 'systemContext');
  if (systemContext && systemContext.length > 20_000) {
    throw new Error("Domain profile 'systemContext' must be at most 20000 characters.");
  }
  return {
    name: stringField(record, 'name', true)!,
    ...(stringField(record, 'description') ? { description: stringField(record, 'description') } : {}),
    routingKeywords: stringList(record, 'routingKeywords', { required: true }),
    readTools: stringList(record, 'readTools', { required: true, toolNames: true }),
    ...(record.writeTools !== undefined
      ? { writeTools: stringList(record, 'writeTools', { toolNames: true }) }
      : {}),
    ...(systemContext ? { systemContext } : {}),
  };
}
