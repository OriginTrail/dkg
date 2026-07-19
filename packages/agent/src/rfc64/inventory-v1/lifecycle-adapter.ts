/**
 * Internal lifecycle adapter for the RFC-64 SQL-A namespace protocol.
 *
 * Production callers receive a hook-free frozen adapter. Tests may construct
 * a distinct frozen adapter per opener; there is deliberately no mutable
 * process-global registry that shipped code could activate at runtime.
 */

export const INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY =
  'posix-atomic-rename-directory-fsync-v1' as const;

export type InventoryV1QuarantineCapability =
  typeof INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY;

export type InventoryV1QuarantineBoundary =
  | 'target-exclusivity-proven'
  | `begin.source.${'wal' | 'shm' | 'main'}.file-fsync`
  | 'begin.inventory-directory.fsync-after-quarantine-root'
  | 'begin.quarantine-root.fsync-after-generation'
  | 'begin.marker.write'
  | 'begin.marker.file-fsync'
  | 'begin.inventory-directory.fsync-after-marker'
  | `resume.prefix.${'wal' | 'shm' | 'main'}.file-fsync`
  | `resume.prefix.${'wal' | 'shm' | 'main'}.generation-directory-fsync`
  | `resume.prefix.${'wal' | 'shm' | 'main'}.inventory-directory-fsync`
  | `resume.source.${'wal' | 'shm' | 'main'}.file-fsync-after-quiescence`
  | `resume.member.${'wal' | 'shm' | 'main'}.rename`
  | `resume.member.${'wal' | 'shm' | 'main'}.file-fsync`
  | `resume.member.${'wal' | 'shm' | 'main'}.generation-directory-fsync`
  | `resume.member.${'wal' | 'shm' | 'main'}.inventory-directory-fsync`
  | 'resume.marker.unlink'
  | 'resume.inventory-directory.fsync-after-marker-unlink';

export type InventoryV1TargetCloseReason =
  | 'automatic-schema-quarantine'
  | 'automatic-corrupt-quarantine'
  | 'failed-open-cleanup'
  | 'foundation-close'
  | 'explicit-quarantine'
  | 'pending-quarantine-probe';

export interface InventoryV1LifecycleAdapter {
  readonly quarantineCapability: InventoryV1QuarantineCapability | null;
  readonly boundary: (boundary: InventoryV1QuarantineBoundary) => void;
  readonly closeTarget: (
    close: () => void,
    reason: InventoryV1TargetCloseReason,
  ) => void;
}

export function createProductionInventoryV1LifecycleAdapter(
  quarantineCapability: InventoryV1QuarantineCapability | null,
): InventoryV1LifecycleAdapter {
  return Object.freeze({
    quarantineCapability,
    boundary: (_boundary: InventoryV1QuarantineBoundary): void => {},
    closeTarget: (close: () => void, _reason: InventoryV1TargetCloseReason): void => {
      close();
    },
  });
}
