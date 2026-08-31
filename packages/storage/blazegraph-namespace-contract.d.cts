interface BlazegraphNamespaceContract {
  readonly BLAZEGRAPH_NAMESPACE_PATTERN: RegExp;
  readonly BLAZEGRAPH_NAMESPACE_XML_TEMPLATE: string;
  assertBlazegraphNamespace(namespace: string): void;
  normalizeBlazegraphNamespace(namespace: string): string;
  renderBlazegraphNamespaceXml(namespace: string): string;
}

declare const contract: BlazegraphNamespaceContract;
export = contract;
