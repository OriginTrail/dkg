// SPDX-License-Identifier: Apache-2.0

export type Rfc64PublicCatalogNativeReceiverErrorCodeV1 =
  | 'catalog-native-receiver-input'
  | 'catalog-native-receiver-not-found'
  | 'catalog-native-receiver-incomplete'
  | 'catalog-native-receiver-slice'
  | 'catalog-native-receiver-catalog'
  | 'catalog-native-receiver-authorization'
  | 'catalog-native-receiver-transfer'
  | 'catalog-native-receiver-activation'
  | 'catalog-native-receiver-history';

export class Rfc64PublicCatalogNativeReceiverErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogNativeReceiverErrorV1';
  }
}

export function failRfc64PublicCatalogNativeV1(
  code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogNativeReceiverErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
