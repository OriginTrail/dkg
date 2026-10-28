// SPDX-License-Identifier: Apache-2.0
export const CATALOG_PUBLICATION_ADMISSION_CODE = 'CATALOG_PUBLICATION_ADMISSION_INVALID';
export class CatalogPublicationAdmissionError extends Error {
  readonly code = CATALOG_PUBLICATION_ADMISSION_CODE;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'CatalogPublicationAdmissionError';
  }
}
