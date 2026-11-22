// SPDX-License-Identifier: Apache-2.0
import type { Payload } from "./room.js";

export const extensionVersion = "1-draft.1";
export type Decision =
  | { api_version: typeof extensionVersion; outcome: "allow" }
  | { api_version: typeof extensionVersion; outcome: "deny"; reason: string };
export type Admission =
  | { outcome: "allow" | "policy_unavailable" }
  | { outcome: "deny"; reason: string };
export interface BaseContext {
  readonly operationId: string;
  readonly policyRevision: string;
}
export interface EventContext extends BaseContext {
  readonly role: "audience";
  readonly roomId: string;
  readonly connectionId: string;
  readonly presenterEpoch: string;
  readonly displayEpoch: string;
  readonly requestId: string;
  readonly payload: Readonly<Payload>;
}
export interface Contexts {
  beforeRoomCreate: BaseContext & { readonly role: "operator"; readonly idempotencyKey: string };
  beforeAudienceJoin: BaseContext & {
    readonly role: "audience";
    readonly roomId: string;
    readonly connectionId: string;
    readonly presenterEpoch: string;
    readonly displayEpoch: string;
  };
  beforeEventForward: EventContext;
  onDisconnect: BaseContext & {
    readonly role: "presenter" | "audience";
    readonly roomId: string;
    readonly connectionId: string;
  };
  onRoomEnd: BaseContext & { readonly roomId: string; readonly state: "Ended" | "Expired" };
}
export type AdmissionHook = "beforeRoomCreate" | "beforeAudienceJoin" | "beforeEventForward";
export type NotificationHook = "onDisconnect" | "onRoomEnd";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface PolicyState {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface HookTools {
  readonly signal: AbortSignal;
  readonly state?: PolicyState;
}
export type AdmissionPolicy = {
  readonly id: string;
  readonly api_version: typeof extensionVersion;
} & {
  [H in AdmissionHook]?: (
    context: Readonly<Contexts[H]>,
    tools: HookTools,
  ) => Decision | Promise<Decision>;
} & {
  [H in NotificationHook]?: (
    context: Readonly<Contexts[H]>,
    tools: HookTools,
  ) => void | Promise<void>;
};
export interface ExtensionOptions {
  timeoutMs?: number;
  maxPending?: number;
  // The provider must return a separate namespace for each operator-selected ID.
  state?: (namespace: string) => PolicyState;
}
const hookNames = [
  "beforeRoomCreate",
  "beforeAudienceJoin",
  "beforeEventForward",
  "onDisconnect",
  "onRoomEnd",
] as const;
const unavailable: Admission = Object.freeze({ outcome: "policy_unavailable" });
function decision(value: unknown): Admission {
  const d = value as Decision;
  if (d?.api_version !== extensionVersion) return unavailable;
  if (d.outcome === "allow" && Object.keys(d).length === 2) return { outcome: "allow" };
  if (
    d.outcome === "deny" &&
    Object.keys(d).length === 3 &&
    typeof d.reason === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(d.reason)
  )
    return { outcome: "deny", reason: d.reason };
  return unavailable;
}

// Trusted in-process hooks. Deadlines cancel admission, not arbitrary JS execution.
export class AdmissionPolicies {
  private policies: readonly AdmissionPolicy[] = [];
  private generation = 0n;
  private active = new Set<AbortController>();
  private stopped = false;
  private failures = 0;
  private timeoutMs: number;
  private maxPending: number;
  constructor(
    policies: readonly AdmissionPolicy[] = [],
    private options: ExtensionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 250;
    this.maxPending = options.maxPending ?? 64;
    if (![this.timeoutMs, this.maxPending].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("Invalid extension limit");
    this.replace(policies);
  }
  get revision(): string {
    return String(this.generation);
  }
  has(name: keyof Contexts): boolean {
    return this.policies.some((p) => p[name] !== undefined);
  }
  diagnostics() {
    return {
      running: this.active.size,
      notificationFailures: this.failures,
      revision: this.revision,
    };
  }
  replace(policies: readonly AdmissionPolicy[]): void {
    if (this.stopped || policies.length > 16) throw new Error("Invalid extension configuration");
    const ids = new Set<string>();
    const next = policies.map((p) => {
      if (
        !p ||
        p.api_version !== extensionVersion ||
        typeof p.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(p.id) ||
        ids.has(p.id) ||
        hookNames.some((h) => p[h] !== undefined && typeof p[h] !== "function")
      )
        throw new Error("Invalid extension descriptor");
      ids.add(p.id);
      const descriptor: AdmissionPolicy = { id: p.id, api_version: extensionVersion };
      for (const name of hookNames) {
        const hook = p[name];
        if (hook)
          Object.defineProperty(descriptor, name, { value: hook.bind(p), enumerable: true });
      }
      return Object.freeze(descriptor);
    });
    this.policies = Object.freeze(next);
    this.generation++;
    for (const controller of this.active) controller.abort();
  }
  check<H extends AdmissionHook>(
    name: H,
    context: Omit<Contexts[H], "policyRevision">,
    signal?: AbortSignal,
  ): Promise<Admission> {
    return this.run(name, context, signal);
  }
  notify<H extends NotificationHook>(name: H, context: Omit<Contexts[H], "policyRevision">): void {
    if (!this.has(name)) return;
    void this.run(name, context).then((result) => {
      if (result.outcome !== "allow") this.failures++;
    });
  }
  private run(
    name: keyof Contexts,
    context: Omit<Contexts[keyof Contexts], "policyRevision">,
    signal?: AbortSignal,
  ): Promise<Admission> {
    if (this.stopped || signal?.aborted) return Promise.resolve(unavailable);
    const selected = this.policies.filter((p) => p[name]);
    if (selected.length === 0) return Promise.resolve({ outcome: "allow" });
    if (this.active.size >= this.maxPending) return Promise.resolve(unavailable);
    const revision = this.revision;
    const controller = new AbortController();
    this.active.add(controller);
    let finish!: (result: Admission) => void;
    const result = new Promise<Admission>((resolve) => {
      finish = resolve;
    });
    const cancel = () => {
      controller.abort();
      finish(unavailable);
    };
    const aborted = () => finish(unavailable);
    signal?.addEventListener("abort", cancel, { once: true });
    controller.signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    const payload = (context as Partial<EventContext>).payload;
    const frozen = Object.freeze({
      ...context,
      policyRevision: revision,
      ...(payload === undefined ? {} : { payload: Object.freeze({ ...payload }) }),
    });
    const task = async () => {
      try {
        for (const policy of selected) {
          if (controller.signal.aborted) return unavailable;
          const state = this.options.state?.(policy.id);
          const tools: HookTools = Object.freeze({ signal: controller.signal, state });
          const hook = policy[name] as (
            context: Readonly<typeof frozen>,
            tools: HookTools,
          ) => unknown;
          const value = await hook(frozen, tools);
          if (controller.signal.aborted || revision !== this.revision) return unavailable;
          if (name === "onDisconnect" || name === "onRoomEnd") continue;
          const verdict = decision(value);
          if (verdict.outcome !== "allow") return verdict;
        }
        return { outcome: "allow" } as const;
      } catch {
        return unavailable;
      }
    };
    void task()
      .then(finish)
      .finally(() => {
        this.active.delete(controller);
      });
    // A timed-out uncooperative hook retains its slot until it actually settles.
    void result.then(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", aborted);
    });
    return result;
  }
  close(): void {
    this.stopped = true;
    for (const controller of this.active) controller.abort();
  }
}
