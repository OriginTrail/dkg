export type BundledMarkItDownMetadata = {
  source?: 'release' | 'build';
  cliVersion?: string;
  buildFingerprint?: string;
};

export function checksumPathFor(binaryPath: string): string;
export function metadataPathFor(binaryPath: string): string;
export function parseSha256File(text: string): string;
export function metadataMatchesExpected(
  actualMetadata: BundledMarkItDownMetadata | null,
  expectedMetadata: BundledMarkItDownMetadata | null,
): boolean;
export function readMetadataFile(binaryPath: string): Promise<BundledMarkItDownMetadata | null>;
export function readMetadataFileSync(binaryPath: string): BundledMarkItDownMetadata | null;
export function bundledBinaryValidationFailure(
  binaryPath: string,
  expectedMetadata?: BundledMarkItDownMetadata | null,
): Promise<'checksum' | 'metadata' | null>;
export function bundledBinaryValidationFailureSync(
  binaryPath: string,
  expectedMetadata?: BundledMarkItDownMetadata | null,
): 'checksum' | 'metadata' | null;
export function hasVerifiedBundledBinary(
  binaryPath: string,
  expectedMetadata?: BundledMarkItDownMetadata | null,
): Promise<boolean>;
export function hasVerifiedBundledBinarySync(
  binaryPath: string,
  expectedMetadata?: BundledMarkItDownMetadata | null,
): boolean;
