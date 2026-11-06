import { FIFOAdmission, type FIFOAdmissionEvent } from './internal/fifo-admission.js';

export type StorageACKAdmissionEvent = FIFOAdmissionEvent;

/** ACK collectors keep their own capacity, diagnostics and public call signature. */
export class StorageACKAdmission extends FIFOAdmission {
  constructor(limit: () => number, now = () => performance.now()) {
    super(limit, now, 'StorageACK admission cancelled');
  }
}
