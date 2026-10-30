// SPDX-License-Identifier: Apache-2.0
import { FIFOAdmission } from './fifo-admission.js';

const admissions = new WeakMap<object, FIFOAdmission>();

/** Request-local dependency objects share this agent's four physical read slots.
 * No reset on cancellation/reopen: unsettled providers still own their slots.
 */
export function scalarRegistrationAdmissionFor(agent: object): FIFOAdmission {
  let admission = admissions.get(agent);
  if (!admission) {
    admission = new FIFOAdmission(() => 4);
    admissions.set(agent, admission);
  }
  return admission;
}
