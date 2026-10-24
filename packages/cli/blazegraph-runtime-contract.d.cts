import blazegraphNamespaceContract = require(
  '@origintrail-official/dkg-storage/blazegraph-namespace-contract'
);

interface BlazegraphImageMetadata {
  readonly image: string;
  readonly containerPort: number;
  readonly dataPath: string;
}

interface BlazegraphImageMetadataContract {
  formatBlazegraphImageMetadata(metadata: unknown): string;
  parseBlazegraphImageMetadata(
    value: unknown,
    source?: string,
  ): BlazegraphImageMetadata;
  readBlazegraphImageMetadata(path: string): BlazegraphImageMetadata;
}

declare const contract:
  typeof blazegraphNamespaceContract & BlazegraphImageMetadataContract;
export = contract;
