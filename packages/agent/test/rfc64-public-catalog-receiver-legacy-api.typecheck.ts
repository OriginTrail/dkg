import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogLegacyReceiverReconcilerV1,
} from '@origintrail-official/dkg-agent';

declare const isHeadApplied: (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Promise<boolean>;
declare const reconcileHead: Rfc64PublicCatalogLegacyReceiverReconcilerV1['reconcileHead'];

const legacyReconciler: Rfc64PublicCatalogLegacyReceiverReconcilerV1 = {
  isHeadApplied,
  reconcileHead,
};

const receiver = new Rfc64PublicCatalogReceiverV1(legacyReconciler);
void receiver;
