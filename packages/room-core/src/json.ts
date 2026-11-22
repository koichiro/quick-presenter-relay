// SPDX-License-Identifier: Apache-2.0
// Ordinary parsing validates syntax; a token pass rejects duplicate decoded keys.
export function strictJSON(text: string): unknown {
  if (new TextEncoder().encode(text).length > 4096) throw new Error("Message too large");
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 32) throw new Error("JSON nesting too deep");
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw new Error("Duplicate JSON key");
      keys?.add(key);
    }
  }
  return value;
}
