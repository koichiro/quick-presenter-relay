// SPDX-License-Identifier: Apache-2.0
// Minimal trace oracle. No sockets, auth, persistence, policy implementation or server.
export class ContractModel {
  constructor({ expires_at = null } = {}) {
    this.state = "created";
    this.epoch = 0n;
    this.display = 0n;
    this.paused = false;
    this.members = new Set();
    this.pending = new Map();
    this.events = new Map();
    this.expiry = expires_at;
    this.policyRevision = 0n;
    this.hooks = new Map();
  }
  terminal() {
    return ["ended", "expired"].includes(this.state);
  }
  clearPending() {
    this.pending.clear();
  }
  step(s) {
    switch (s.op) {
      case "attach":
        if (this.terminal()) return this.state === "ended" ? "stopped" : "expired";
        this.clearPending();
        this.epoch++;
        this.state = "active";
        return "active";
      case "join":
        if (this.terminal()) return this.state === "ended" ? "stopped" : "expired";
        if (this.state !== "active") return "unavailable";
        if (this.members.has(s.id)) return "joined";
        this.members.add(s.id);
        return "joined";
      case "leave":
        return this.members.delete(s.id) ? "left" : "absent";
      case "offer":
        if (this.terminal()) return this.state === "ended" ? "stopped" : "expired";
        if (this.state !== "active") return "unavailable";
        if (!this.members.has(s.member)) return "denied";
        if (this.events.has(s.id)) return "duplicate";
        this.pending.set(s.id, { epoch: this.epoch });
        this.events.set(s.id, { display: this.display });
        return "pending";
      case "receipt":
        if (this.terminal()) return this.state === "ended" ? "stopped" : "expired";
        if (BigInt(s.epoch) !== this.epoch) return "stale";
        if (!this.pending.has(s.id)) return "unknown";
        this.pending.delete(s.id);
        return s.status ?? "accepted";
      case "timeout":
        this.pending.delete(s.id);
        return "unknown";
      case "disconnect_presenter":
        if (BigInt(s.epoch) !== this.epoch) return "stale";
        if (this.terminal()) return "stopped";
        this.state = "disconnected";
        this.clearPending();
        return "disconnected";
      case "display":
        if (this.terminal()) return "stopped";
        if (BigInt(s.epoch) !== this.epoch || BigInt(s.display) <= this.display) return "stale";
        this.display = BigInt(s.display);
        this.paused = s.paused;
        return "updated";
      case "overlay":
        return !this.terminal() && !this.paused && this.events.get(s.id)?.display === this.display
          ? "visible"
          : "hidden";
      case "end":
        this.state = "ended";
        this.clearPending();
        this.members.clear();
        return "ended";
      case "tick":
        if (!this.terminal() && this.expiry !== null && s.now >= this.expiry) {
          this.state = "expired";
          this.clearPending();
          this.members.clear();
        }
        return this.state;
      case "policy_revision":
        if (BigInt(s.revision) <= this.policyRevision) return "stale";
        this.policyRevision = BigInt(s.revision);
        return "updated";
      case "policy":
        if (["throw", "timeout"].includes(s.mode)) return "policy_unavailable";
        return s.mode === "deny" ? "denied" : "allow";
      case "policy_start":
        this.hooks.set(s.id, {
          epoch: this.epoch,
          display: this.display,
          policy: this.policyRevision,
        });
        return "pending";
      case "policy_complete": {
        const captured = this.hooks.get(s.id);
        this.hooks.delete(s.id);
        if (this.terminal()) return "stopped";
        if (
          !captured ||
          captured.epoch !== this.epoch ||
          captured.display !== this.display ||
          captured.policy !== this.policyRevision
        )
          return "stale";
        return "allow";
      }
      default:
        throw new Error(`Unknown trace operation ${s.op}`);
    }
  }
}
