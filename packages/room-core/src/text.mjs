// SPDX-License-Identifier: Apache-2.0
// Unicode 15.1 White_Space. Rust/browsers must use this exact set for conformance.
const white = /[\t-\r\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
/** @param {string} body */
export function normalizeBody(body) {
  return body.replace(white, " ").replace(/^ +| +$/g, "");
}
