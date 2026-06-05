import type { ContextGraph } from '../../../stores/projects.js';

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatLocalTimestamp(value?: string | Date): string {
  if (value === undefined || value === null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) return typeof value === 'string' ? value : '';
  // Include the date so a chat that spans more than one day stays
  // legible — `HH:MM AM/PM` alone was ambiguous as soon as a session
  // crossed midnight. `medium` date + `short` time renders e.g.
  // "May 14, 2026, 10:05 PM" in en-US.
  return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Companion to `formatLocalTimestamp` that returns an ISO 8601 string
 * for the same moment. Used to populate `<time dateTime={tsRaw}>` so
 * screen readers and machine parsers can read the timestamp in a
 * locale-independent format alongside the human-readable display
 * (UX-lead P1-A minimum). Returns `undefined` for absent / unparseable
 * input so the caller can drop the prop instead of emitting an empty
 * `dateTime` attribute.
 */
export function toIsoTimestamp(value?: string | Date): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) return undefined;
  return parsed.toISOString();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileBadge(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt', 'csv', 'json', 'xml', 'yaml', 'yml'].includes(ext)) return 'TXT';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['docx', 'doc'].includes(ext)) return 'DOC';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'IMG';
  if (['py', 'ts', 'js', 'tsx', 'jsx', 'java', 'go', 'rs', 'c', 'cpp'].includes(ext)) return 'CODE';
  return 'FILE';
}

export function getProjectDisplayName(projects: ContextGraph[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

export function toContextGraphUri(projectId: string): string {
  return projectId.startsWith('did:dkg:context-graph:')
    ? projectId
    : `did:dkg:context-graph:${projectId}`;
}

export function formatAttachmentImportContextValue(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
