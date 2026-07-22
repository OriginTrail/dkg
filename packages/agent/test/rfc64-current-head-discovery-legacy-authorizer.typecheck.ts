import {
  type Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1,
} from '@origintrail-official/dkg-agent';

declare const controlObjects:
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1['controlObjects'];
declare const readCurrentAppliedCatalogHeadDigest:
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1[
    'readCurrentAppliedCatalogHeadDigest'
  ];
declare const authorizeOpenCatalogOperation: NonNullable<
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1[
    'authorizeOpenCatalogOperation'
  ]
>;
declare const verifyIssuerSignature:
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1['verifyIssuerSignature'];

const legacyOptions: Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1 = {
  controlObjects,
  readCurrentAppliedCatalogHeadDigest,
  authorizeOpenCatalogOperation,
  verifyIssuerSignature,
};

void legacyOptions;
