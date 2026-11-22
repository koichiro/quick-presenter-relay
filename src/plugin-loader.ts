// SPDX-License-Identifier: Apache-2.0
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AdmissionPolicies, type AdmissionPolicy } from "quick-presenter-relay-core";

// Import only explicitly selected local files at startup, never network endpoints.
export async function loadPolicies(
  configPath: string,
  modules: unknown,
): Promise<AdmissionPolicies> {
  if (modules === undefined) return new AdmissionPolicies();
  if (!Array.isArray(modules) || modules.length > 16) throw new Error("Invalid extension modules");
  const policies: AdmissionPolicy[] = [];
  for (const path of modules) {
    if (
      typeof path !== "string" ||
      !/\.(mjs|js)$/.test(path) ||
      (!isAbsolute(path) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))
    )
      throw new Error("Invalid local extension path");
    const module = await import(pathToFileURL(resolve(dirname(configPath), path)).href);
    policies.push(module.default);
  }
  return new AdmissionPolicies(policies);
}
