import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64BoundedPublicRootCatalogNativeReconcilerV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogReceiverReconcilerV1,
} from '@origintrail-official/dkg-agent';

declare const isHeadApplied: (
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
) => Promise<boolean>;
declare const reconcileHead: (
  remotePeerId: string,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  signal: AbortSignal,
) => Promise<'applied'>;

const legacyReconciler: Rfc64PublicCatalogReceiverReconcilerV1 = {
  isHeadApplied,
  reconcileHead,
};

const receiver = new Rfc64PublicCatalogReceiverV1(legacyReconciler);
void receiver;

declare const nativeReconciler: Rfc64BoundedPublicRootCatalogNativeReconcilerV1;
void nativeReconciler.isHeadApplied({} as Rfc64PublicCatalogHeadAnnouncementV1);
