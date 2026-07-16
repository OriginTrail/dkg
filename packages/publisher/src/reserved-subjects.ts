// Protocol-reserved URN namespaces that MUST NOT appear as subjects in
// user-authored quads. These prefixes are owned by the daemon's
// import-file handler for file descriptors and extraction provenance.
export const RESERVED_SUBJECT_PREFIXES = [
  'urn:dkg:file:',
  'urn:dkg:extraction:',
] as const;

export function findReservedSubjectPrefix(subject: string): string | undefined {
  const lower = subject.toLowerCase();
  return RESERVED_SUBJECT_PREFIXES.find((prefix) => lower.startsWith(prefix));
}

export function isReservedSubject(subject: string): boolean {
  return findReservedSubjectPrefix(subject) !== undefined;
}
