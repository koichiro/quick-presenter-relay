// SPDX-License-Identifier: Apache-2.0
// Browser and server must agree on the existing scalar, control and whitespace rules.
export const draftText = [
  { body: "", handle: "Name", valid: false },
  { body: " \t\r\n\u3000\u00a0\u2028\u2029", handle: "", valid: false },
  { body: "\ufeff", handle: "", valid: true },
  { body: "First\r\nSecond\tline", handle: " Name\t", valid: true },
  { body: "😀".repeat(200), handle: "🦀".repeat(32), valid: true },
  { body: "x".repeat(201), handle: "Name", valid: false },
  { body: "😀".repeat(201), handle: "Name", valid: false },
  { body: "Hello", handle: "x".repeat(33), valid: false },
  { body: "Hello", handle: "😀".repeat(33), valid: false },
  ...["\ud800", "\udfff", "\ud800x", "x\udfff"].flatMap((text) => [
    { body: text, handle: "Name", valid: false },
    { body: "Hello", handle: text, valid: false },
  ]),
  ...Array.from({ length: 160 }, (_, point) => point)
    .filter((point) => (point < 32 || point >= 127) && ![9, 10, 13].includes(point))
    .flatMap((point) => [
      { body: `Hello${String.fromCodePoint(point)}`, handle: "Name", valid: false },
      { body: "Hello", handle: `Name${String.fromCodePoint(point)}`, valid: false },
    ]),
];
