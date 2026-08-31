interface BlazegraphImageMetadata {
  readonly image: string;
  readonly containerPort: number;
  readonly dataPath: string;
}

interface BlazegraphRuntimeContract {
  readonly BLAZEGRAPH_NAMESPACE_XML_TEMPLATE: string;
  assertBlazegraphNamespace(namespace: string): void;
  normalizeBlazegraphNamespace(namespace: string): string;
  formatBlazegraphImageMetadata(metadata: unknown): string;
  parseBlazegraphImageMetadata(
    value: unknown,
    source?: string,
  ): BlazegraphImageMetadata;
  readBlazegraphImageMetadata(path: string): BlazegraphImageMetadata;
  renderBlazegraphNamespaceXml(namespace: string): string;
}

declare const contract: BlazegraphRuntimeContract;
export = contract;
