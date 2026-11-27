import type { ContextGraph } from '../../../stores/projects.js';

export { formatAttachmentImportContextValue, formatLocalTimestamp, toIsoTimestamp } from '../../../conversations/format.js';

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
