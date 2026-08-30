import blazegraphRuntimeContract from
  '@origintrail-official/dkg/blazegraph-runtime-contract';

export interface BlazegraphImageMetadata {
  readonly image: string;
  readonly containerPort: number;
  readonly dataPath: string;
}

export const BLAZEGRAPH_NAMESPACE_XML_TEMPLATE: string =
  blazegraphRuntimeContract.BLAZEGRAPH_NAMESPACE_XML_TEMPLATE;

export const readBlazegraphImageMetadata: (
  path: string,
) => BlazegraphImageMetadata = blazegraphRuntimeContract.readBlazegraphImageMetadata;

export const renderBlazegraphNamespaceXml: (
  namespace: string,
) => string = blazegraphRuntimeContract.renderBlazegraphNamespaceXml;
