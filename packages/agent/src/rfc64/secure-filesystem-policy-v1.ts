import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  statSync,
} from 'node:fs';
import { chmod, open, stat } from 'node:fs/promises';

export const RFC64_SECURE_DIRECTORY_MODE_V1 = 0o700;
export const RFC64_SECURE_FILE_MODE_V1 = 0o600;
export const RFC64_POSIX_NAMESPACE_DURABILITY_V1 =
  'posix-hardlink-no-replace-directory-fsync-v1' as const;
export const RFC64_WINDOWS_NAMESPACE_DURABILITY_V1 =
  'windows-file-flush-hardlink-no-replace-v1' as const;

export type Rfc64NamespaceDurabilityV1 =
  | typeof RFC64_POSIX_NAMESPACE_DURABILITY_V1
  | typeof RFC64_WINDOWS_NAMESPACE_DURABILITY_V1;

export type Rfc64FilesystemEntryKindV1 = 'file' | 'directory';

export interface Rfc64FilesystemEntryPolicyV1 {
  readonly entryKind: Rfc64FilesystemEntryKindV1;
}

export function rfc64UsesWindowsFilesystemPolicyV1(): boolean {
  return process.platform === 'win32';
}

export function rfc64NamespaceDurabilityV1(): Rfc64NamespaceDurabilityV1 {
  return rfc64UsesWindowsFilesystemPolicyV1()
    ? RFC64_WINDOWS_NAMESPACE_DURABILITY_V1
    : RFC64_POSIX_NAMESPACE_DURABILITY_V1;
}

export function rfc64CurrentUserOwnsUidV1(uid: number): boolean {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return true;
  const processUid = process.getuid?.();
  return processUid === undefined || uid === processUid;
}

export function rfc64PosixModeMatchesV1(mode: number, expected: number): boolean {
  return rfc64UsesWindowsFilesystemPolicyV1() || (mode & 0o777) === expected;
}

export function assertRfc64FilesystemOwnerSyncV1(path: string): void {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    assertWindowsFilesystemOwnerSync(
      path,
      statSync(path).isDirectory() ? 'directory' : 'file',
    );
    return;
  }
  if (!rfc64CurrentUserOwnsUidV1(statSync(path).uid)) {
    throw new Error('RFC-64 filesystem entry is not owned by the current process uid');
  }
}

export async function assertRfc64FilesystemOwnerV1(path: string): Promise<void> {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    const entry = await stat(path);
    await assertWindowsFilesystemOwner(path, entry.isDirectory() ? 'directory' : 'file');
    return;
  }
  if (!rfc64CurrentUserOwnsUidV1((await stat(path)).uid)) {
    throw new Error('RFC-64 filesystem entry is not owned by the current process uid');
  }
}

export function assertRfc64OwnerOnlyPermissionsSyncV1(
  path: string,
  expectedMode: number,
  policy: Rfc64FilesystemEntryPolicyV1,
): void {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    assertWindowsOwnerOnlyPermissionsSync(path, policy.entryKind);
    return;
  }
  const stat = statSync(path);
  if (!rfc64CurrentUserOwnsUidV1(stat.uid)) {
    throw new Error('RFC-64 filesystem entry is not owned by the current process uid');
  }
  if (!rfc64PosixModeMatchesV1(stat.mode, expectedMode)) {
    throw new Error(
      `RFC-64 path mode ${(stat.mode & 0o777).toString(8)} does not match ${expectedMode.toString(8)}`,
    );
  }
}

export async function assertRfc64OwnerOnlyPermissionsV1(
  path: string,
  expectedMode: number,
  policy: Rfc64FilesystemEntryPolicyV1,
): Promise<void> {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    await assertWindowsOwnerOnlyPermissions(path, policy.entryKind);
    return;
  }
  const entry = await stat(path);
  if (!rfc64CurrentUserOwnsUidV1(entry.uid)) {
    throw new Error('RFC-64 filesystem entry is not owned by the current process uid');
  }
  if (!rfc64PosixModeMatchesV1(entry.mode, expectedMode)) {
    throw new Error(
      `RFC-64 path mode ${(entry.mode & 0o777).toString(8)} does not match ${expectedMode.toString(8)}`,
    );
  }
}

export function applyRfc64OwnerOnlyPermissionsSyncV1(
  path: string,
  mode: number,
  policy: Rfc64FilesystemEntryPolicyV1,
): void {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    applyWindowsOwnerOnlyPermissionsSync(path, policy.entryKind);
    return;
  }
  assertRfc64FilesystemOwnerSyncV1(path);
  chmodSync(path, mode);
  assertRfc64OwnerOnlyPermissionsSyncV1(path, mode, policy);
}

export async function applyRfc64OwnerOnlyPermissionsV1(
  path: string,
  mode: number,
  policy: Rfc64FilesystemEntryPolicyV1,
): Promise<void> {
  if (rfc64UsesWindowsFilesystemPolicyV1()) {
    await applyWindowsOwnerOnlyPermissions(path, policy.entryKind);
    return;
  }
  await assertRfc64FilesystemOwnerV1(path);
  await chmod(path, mode);
  await assertRfc64OwnerOnlyPermissionsV1(path, mode, policy);
}

/** Node cannot FlushFileBuffers on a Windows directory handle. */
export async function fsyncRfc64DirectoryV1(path: string): Promise<void> {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error('RFC-64 directory fsync target is not a directory');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Synchronous twin used by the SQLite inventory lifecycle. */
export function fsyncRfc64DirectorySyncV1(path: string): void {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** FlushFileBuffers requires a write-capable Windows handle. */
export function rfc64RegularFileFsyncOpenFlagsV1(): string | number {
  return rfc64UsesWindowsFilesystemPolicyV1()
    ? 'r+'
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

export function rfc64RegularFileReadOpenFlagsV1(): number {
  return constants.O_RDONLY
    | (rfc64UsesWindowsFilesystemPolicyV1() ? 0 : constants.O_NOFOLLOW);
}

const WINDOWS_ACL_POWERSHELL_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User
$defaultOwnerSid = $identity.Owner
$target = [System.IO.Path]::GetFullPath($env:DKG_RFC64_ACL_PATH)
$isDirectory = [System.Convert]::ToBoolean($env:DKG_RFC64_ACL_DIRECTORY)

function Read-TargetAcl {
  if ($isDirectory) {
    return [System.IO.Directory]::GetAccessControl(
      $target,
      [System.Security.AccessControl.AccessControlSections]'Owner, Access'
    )
  }
  return [System.IO.File]::GetAccessControl(
    $target,
    [System.Security.AccessControl.AccessControlSections]'Owner, Access'
  )
}

function Assert-CurrentOwner($acl) {
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (
    $owner.Value -ne $userSid.Value -and
    $owner.Value -ne $defaultOwnerSid.Value
  ) {
    throw "owner SID $($owner.Value) is not the current token owner"
  }
}
`;

const WINDOWS_OWNER_ONLY_ASSERTION = String.raw`
function Assert-OwnerOnly($acl) {
  if (-not $acl.AreAccessRulesProtected) {
    throw 'RFC-64 owner-only ACL must disable inherited access rules'
  }
  $allowedRights = 0
  foreach ($rule in $acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    if ($rule.IdentityReference.Value -ne $userSid.Value) {
      throw "allow ACL grants another SID: $($rule.IdentityReference.Value)"
    }
    $allowedRights = $allowedRights -bor [int]$rule.FileSystemRights
  }
  $fullControl = [int][System.Security.AccessControl.FileSystemRights]::FullControl
  if (($allowedRights -band $fullControl) -ne $fullControl) {
    throw 'current user does not hold FullControl on the RFC-64 path'
  }
}
`;

const WINDOWS_FILESYSTEM_OWNER_SCRIPT = `${WINDOWS_ACL_POWERSHELL_PRELUDE}
$acl = Read-TargetAcl
Assert-CurrentOwner $acl`;

const WINDOWS_OWNER_ONLY_ASSERTION_SCRIPT = `${WINDOWS_ACL_POWERSHELL_PRELUDE}
${WINDOWS_OWNER_ONLY_ASSERTION}
$acl = Read-TargetAcl
Assert-CurrentOwner $acl
Assert-OwnerOnly $acl`;

const WINDOWS_OWNER_ONLY_APPLICATION_SCRIPT = `${WINDOWS_ACL_POWERSHELL_PRELUDE}
${WINDOWS_OWNER_ONLY_ASSERTION}
$existingAcl = Read-TargetAcl
Assert-CurrentOwner $existingAcl
$acl = if ($isDirectory) {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $userSid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
if ($isDirectory) {
  [System.IO.Directory]::SetAccessControl($target, $acl)
} else {
  [System.IO.File]::SetAccessControl($target, $acl)
}
$acl = Read-TargetAcl
Assert-CurrentOwner $acl
Assert-OwnerOnly $acl`;

function assertWindowsFilesystemOwnerSync(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): void {
  runWindowsAclOperation(
    path,
    entryKind,
    'owner assertion',
    WINDOWS_FILESYSTEM_OWNER_SCRIPT,
  );
}

async function assertWindowsFilesystemOwner(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): Promise<void> {
  await runWindowsAclOperationAsync(
    path,
    entryKind,
    'owner assertion',
    WINDOWS_FILESYSTEM_OWNER_SCRIPT,
  );
}

function assertWindowsOwnerOnlyPermissionsSync(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): void {
  runWindowsAclOperation(
    path,
    entryKind,
    'owner-only assertion',
    WINDOWS_OWNER_ONLY_ASSERTION_SCRIPT,
  );
}

async function assertWindowsOwnerOnlyPermissions(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): Promise<void> {
  await runWindowsAclOperationAsync(
    path,
    entryKind,
    'owner-only assertion',
    WINDOWS_OWNER_ONLY_ASSERTION_SCRIPT,
  );
}

function applyWindowsOwnerOnlyPermissionsSync(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): void {
  runWindowsAclOperation(
    path,
    entryKind,
    'owner-only application',
    WINDOWS_OWNER_ONLY_APPLICATION_SCRIPT,
  );
}

async function applyWindowsOwnerOnlyPermissions(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
): Promise<void> {
  await runWindowsAclOperationAsync(
    path,
    entryKind,
    'owner-only application',
    WINDOWS_OWNER_ONLY_APPLICATION_SCRIPT,
  );
}

function runWindowsAclOperation(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
  operation: string,
  script: string,
): void {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        DKG_RFC64_ACL_DIRECTORY: String(entryKind === 'directory'),
        DKG_RFC64_ACL_PATH: path,
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `RFC-64 Windows ACL ${operation} failed for ${path}: ${
        result.error?.message
          ?? (result.stderr.trim() || `PowerShell exited ${result.status}`)
      }`,
      result.error === undefined ? {} : { cause: result.error },
    );
  }
}

async function runWindowsAclOperationAsync(
  path: string,
  entryKind: Rfc64FilesystemEntryKindV1,
  operation: string,
  script: string,
): Promise<void> {
  await new Promise<void>((resolveOperation, rejectOperation) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          DKG_RFC64_ACL_DIRECTORY: String(entryKind === 'directory'),
          DKG_RFC64_ACL_PATH: path,
        },
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (cause) => {
      rejectOperation(new Error(
        `RFC-64 Windows ACL ${operation} failed for ${path}: ${cause.message}`,
        { cause },
      ));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolveOperation();
        return;
      }
      rejectOperation(new Error(
        `RFC-64 Windows ACL ${operation} failed for ${path}: ${
          stderr.trim() || `PowerShell exited ${code}`
        }`,
      ));
    });
  });
}
