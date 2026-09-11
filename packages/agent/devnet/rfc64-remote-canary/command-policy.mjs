// SPDX-License-Identifier: Apache-2.0

import { invalid } from './common.mjs';

/** Reject command arguments that could persist credentials in configuration or evidence. */
export function validateCommandV1(value) {
  for (const arg of value.argv) {
    if (
      /(?:^|[=\s])authorization\s*:\s*(?:bearer|basic)\s+\S+/iu.test(arg)
      || /:\/\/[^/@:]+:[^/@]+@/u.test(arg)
      || /^--?(?:user|password|passwd|token|api[-_]?key|secret|authorization)(?:=|$)/iu.test(arg)
      || /^-(?:u|U)(?:.+)?$/u.test(arg)
      || /^(?:[A-Z0-9_]*_)?(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|AUTHORIZATION)=.+$/iu.test(arg)
    ) invalid('inline-command-secret-rejected');
  }
  return Object.freeze({ argv: Object.freeze([...value.argv]) });
}
