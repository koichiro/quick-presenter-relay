// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mountAudience } from "quick-presenter-audience-web";
import { validate } from "../scripts/contracts.mjs";
import { draftText } from "./fixtures/draft-text.mjs";
import { emojiComments, emojiHandle } from "./fixtures/emoji-comments.mjs";

function setup({
  secure = false,
  token = "A".repeat(43),
  storage = new Map(),
  blocked = false,
  pathname = "/join/room",
} = {}) {
  const element = (value = "", dataset = {}) => ({
    value,
    dataset,
    disabled: true,
    hidden: true,
    events: {},
    error: "",
    addEventListener(type, handler) {
      this.events[type] = handler;
    },
    setCustomValidity(message) {
      this.error = message;
    },
    get validity() {
      return { valid: this.error === "" };
    },
  });
  const status = { textContent: "" },
    feedback = { textContent: "Send a reaction to the presenter." };
  const reaction = element("", { kind: "heart" }),
    send = element(),
    retry = element();
  const form = element(),
    field = element(),
    nickname = element("Anonymous");
  let reports = 0;
  form.requestSubmit = () => form.events.submit({ preventDefault() {} });
  form.reportValidity = () => {
    reports++;
  };
  const sockets = [],
    timers = new Map();
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    events = {};
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(type, handler) {
      this.events[type] = handler;
    }
    send(data) {
      assert.equal(this.readyState, 1);
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.events.close?.();
    }
  }
  const replaced = [],
    protocol = secure ? "https:" : "http:";
  const elements = {
    "#connection-status": status,
    "#feedback": feedback,
    "#retry": retry,
    form,
    "#message": field,
    "#nickname": nickname,
    "#send-comment": send,
  };
  const env = {
    location: {
      hash: token === null ? "" : `#k=${token}`,
      pathname,
      protocol,
      href: `${protocol}//relay.example${pathname}`,
    },
    history: { replaceState: (...args) => replaced.push(args) },
    sessionStorage: {
      setItem(key, value) {
        if (blocked) throw new Error("Unavailable");
        storage.set(key, value);
      },
      getItem(key) {
        if (blocked) throw new Error("Unavailable");
        return storage.get(key) ?? null;
      },
      removeItem(key) {
        if (blocked) throw new Error("Unavailable");
        storage.delete(key);
      },
    },
    document: {
      querySelector(name) {
        assert.ok(elements[name], name);
        return elements[name];
      },
      querySelectorAll(name) {
        assert.equal(name, "[data-kind]");
        return [reaction];
      },
    },
    WebSocket: Socket,
    URL,
    URLSearchParams,
    TextEncoder,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const initial = mountAudience(env);
  const socket = () => sockets.at(-1);
  const message = (fields, target = socket()) =>
    target.events.message({
      data: JSON.stringify({ protocol: "qp.audience", version: "1", ...fields }),
    });
  const welcome = (available = true) => {
    socket().readyState = 1;
    socket().events.open();
    message({
      type: "welcome",
      connection_id: "a1",
      capabilities: ["comments", "reactions"],
      available,
      limits: { max_message_bytes: 4096, request_cache_ms: 30000 },
    });
  };
  const submit = (body = "Hello 世界", handle = "Anonymous") => {
    field.value = body;
    nickname.value = handle;
    form.events.submit({ preventDefault() {} });
  };
  const result = (status = "accepted", request_id = socket().sent.at(-1).request_id) =>
    message({ type: "result", request_id, status });
  const key = (overrides = {}) => {
    let prevented = false;
    field.events.keydown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      ...overrides,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  return {
    initial,
    socket,
    sockets,
    status,
    feedback,
    reaction,
    send,
    retry,
    form,
    field,
    nickname,
    replaced,
    storage,
    timers,
    env,
    message,
    welcome,
    submit,
    result,
    key,
    reports: () => reports,
  };
}

test("join waits for welcome, preserves plain text and correlates receipts without duplicate sends", () => {
  const t = setup();
  assert.equal(t.replaced[0][2], "/join/room");
  assert.equal(t.socket().url, "ws://relay.example/ws/audience/room");
  t.reaction.events.click();
  t.submit();
  assert.equal(t.socket().sent.length, 0);
  t.message({ type: "state", revision: "1", available: true });
  assert(t.send.disabled);
  t.welcome();
  assert.equal(t.socket().sent[0].token, "A".repeat(43));
  t.submit('<script>alert("x")</script>\n世界', " Original ");
  assert.equal(t.socket().sent[1].body, '<script>alert("x")</script>\n世界');
  assert.equal(t.socket().sent[1].handle, " Original ");
  t.reaction.events.click();
  t.submit("Changed draft");
  assert.equal(t.socket().sent.length, 2);
  t.result("accepted", "unmatched");
  assert(t.send.disabled);
  assert.equal(t.timers.size, 1);
  t.result();
  assert.equal(t.feedback.textContent, "Comment received.");
  assert.equal(t.field.value, "Changed draft");
  assert.equal(t.timers.size, 0);
  t.submit();
  t.result();
  assert.equal(t.field.value, "");
  t.field.value = "Draft";
  t.reaction.events.click();
  t.result();
  assert.equal(t.field.value, "Draft");
  assert.equal(t.feedback.textContent, "Reaction received.");
});

test("same-tab reload restores the room-scoped token, new links replace it and invalid links revoke it", () => {
  const storage = new Map();
  const first = setup({ storage });
  first.welcome();
  first.socket().close();
  const reloaded = setup({ storage, token: null });
  reloaded.welcome();
  reloaded.submit();
  reloaded.result();
  assert.equal(reloaded.feedback.textContent, "Comment received.");
  const next = setup({ storage, token: "C".repeat(43) });
  next.welcome();
  assert.equal(next.socket().sent[0].token, "C".repeat(43));
  assert.equal(setup({ storage, token: null, pathname: "/join/another" }).initial, null);
  assert.equal(setup({ token: null }).initial, null);
  assert.equal(setup({ storage, token: "invalid" }).initial, null);
  assert.equal(setup({ storage, token: null }).initial, null);
  for (const token of ["", "bad"]) assert.equal(setup({ token }).initial, null);
});

test("blocked storage keeps the fragment and HTTPS uses WSS", () => {
  const t = setup({ blocked: true, secure: true });
  t.welcome();
  assert.deepEqual(t.replaced, []);
  assert.match(t.socket().url, /^wss:/);
  assert.equal(t.socket().sent[0].token, "A".repeat(43));
  assert.equal(setup({ blocked: true, token: null }).initial, null);
  assert.equal(setup({ blocked: true, token: "invalid" }).initial, null);
});

test("Enter sends, Shift+Enter allows newline and IME confirmation never submits", () => {
  const t = setup();
  t.welcome();
  t.field.value = "First\nSecond";
  for (const flags of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "a" }])
    assert.equal(t.key(flags), false);
  assert.equal(t.socket().sent.length, 1);
  assert(t.key());
  assert.equal(t.socket().sent[1].body, "First\nSecond");
  assert.equal(t.socket().sent[1].handle, "Anonymous");
  assert(t.key());
  assert.equal(t.socket().sent.length, 2);
  t.result();
  t.socket().close();
  assert(t.key());
  assert.equal(t.socket().sent.length, 2);
});

test("Unicode limits, empty drafts and editing invalid input are validated without sending", () => {
  for (const [body, handle] of [
    ["", "Name"],
    [" \n\t", "Name"],
    ["x".repeat(201), "Name"],
    ["😀".repeat(201), "Name"],
    ["Hello", "x".repeat(33)],
    ["Hello", "😀".repeat(33)],
  ]) {
    const t = setup();
    t.welcome();
    t.submit(body, handle);
    assert.equal(t.socket().sent.length, 1);
    assert.equal(t.reports(), 1);
  }
  const t = setup();
  t.welcome();
  t.submit("😀".repeat(200), "🦀".repeat(32));
  t.result();
  t.submit("x".repeat(201), "x".repeat(33));
  t.field.value = "Fixed";
  t.nickname.value = "";
  t.field.events.input();
  t.nickname.events.input();
  assert.equal(t.field.error, "");
  assert.equal(t.nickname.error, "");
  assert(t.key());
  assert.equal(t.socket().sent.at(-1).handle, "");
});

test("draft validation matches server Unicode rules and keeps invalid input connected", () => {
  for (const [index, { body, handle, valid }] of draftText.entries()) {
    const t = setup();
    t.welcome();
    const frame = {
      protocol: "qp.audience",
      version: "1",
      type: "comment",
      request_id: "draft",
      body,
      handle,
    };
    assert.equal(validate("messages", frame), valid, `server case ${index}`);
    t.submit(body, handle);
    assert.equal(t.socket().sent.length, valid ? 2 : 1, `browser case ${index}`);
    assert.equal(t.reports(), valid ? 0 : 1);
    assert.equal(t.field.value, body);
    assert.equal(t.nickname.value, handle);
    assert.equal(t.socket().readyState, 1);
    if (!valid) {
      // Editing a pasted invalid value recovers without replacing the connection.
      t.field.value = "Fixed 😀\ncomment";
      t.nickname.value = "Name";
      t.field.events.input();
      t.nickname.events.input();
      t.key({ isComposing: true });
      assert.equal(t.socket().sent.length, 1);
      t.key();
      assert.equal(t.socket().sent.length, 2);
      assert.equal(validate("messages", t.socket().sent.at(-1)), true);
    }
  }
});

test("connection and welcome timeouts expose manual recovery and fence late callbacks", () => {
  for (const opened of [false, true]) {
    const t = setup();
    const old = t.socket();
    t.field.value = "Retained draft";
    if (opened) {
      old.readyState = 1;
      old.events.open();
      t.message({ type: "state", revision: "1", available: true });
    }
    const timer = [...t.timers.values()][0];
    assert.equal(timer.delay, 10000);
    // Model a peer whose close event is delayed indefinitely.
    old.close = () => {
      old.readyState = 2;
    };
    timer.callback();
    assert.match(t.status.textContent, /timed out/);
    assert.equal(t.retry.hidden, false);
    assert.equal(t.send.disabled, true);
    assert.equal(t.field.value, "Retained draft");
    assert.equal(t.timers.size, 0);
    t.welcome();
    assert.equal(t.send.disabled, true);
    old.events.close();
    old.events.error();
    t.retry.events.click();
    const current = t.socket();
    timer.callback();
    old.events.open();
    old.events.close();
    old.events.error();
    t.message(
      {
        type: "welcome",
        connection_id: "old",
        capabilities: [],
        available: true,
        limits: { max_message_bytes: 4096, request_cache_ms: 30000 },
      },
      old,
    );
    assert.equal(t.timers.size, 1);
    t.welcome();
    assert.equal(t.timers.size, 0);
    assert.equal(current.sent.length, 1);
    assert.equal(t.field.value, "Retained draft");
    t.submit("New submission");
    assert.equal(current.sent.length, 2);
    t.result();
    assert.equal(t.feedback.textContent, "Comment received.");
  }
});

test("welcome cancels its watchdog and close clears a pending connection deadline", () => {
  const t = setup();
  const timer = [...t.timers.values()][0];
  t.welcome(false);
  assert.equal(t.timers.size, 0);
  timer.callback();
  assert.match(t.status.textContent, /Presenter unavailable/);
  const waiting = setup();
  waiting.socket().close();
  assert.equal(waiting.timers.size, 0);
  assert.equal(waiting.retry.hidden, false);
});

test("rejected or unknown receipts keep drafts and release the pending request", () => {
  for (const status of [
    "stopped",
    "unavailable",
    "busy",
    "unknown",
    "expired",
    "denied",
    "policy_unavailable",
  ]) {
    const t = setup();
    t.welcome();
    t.submit("Keep");
    t.result(status);
    assert.equal(t.field.value, "Keep");
    assert.equal(t.send.disabled, false);
    assert.equal(t.timers.size, 0);
    if (status === "unknown") assert.match(t.feedback.textContent, /not resent automatically/);
  }
});

test("availability gates submission and a receipt timeout disconnects without automatic replay", () => {
  const t = setup();
  t.welcome(false);
  t.reaction.events.click();
  t.submit();
  assert.equal(t.socket().sent.length, 1);
  t.message({ type: "state", revision: "1", available: true });
  t.submit("Keep");
  const timer = [...t.timers.values()][0];
  assert.equal(timer.delay, 4000);
  timer.callback();
  assert.equal(t.retry.hidden, false);
  assert.equal(t.field.value, "Keep");
  assert.equal(t.send.disabled, true);
  assert.match(t.feedback.textContent, /No response/);
  const old = t.socket();
  t.retry.events.click();
  t.welcome();
  assert.equal(t.socket().sent.length, 1);
  t.submit("New");
  old.events.open();
  old.events.close();
  old.events.error();
  t.message({ type: "result", request_id: "2", status: "accepted" }, old);
  assert(t.send.disabled);
  assert.equal(t.field.value, "New");
  t.result();
  assert.equal(t.field.value, "");
});

test("closed sockets, malformed frames and wrong protocols fail safely", async () => {
  for (const data of [
    "bad",
    "null",
    '{"protocol":"other","version":"1"}',
    '{"protocol":"qp.audience","version":"other"}',
  ]) {
    const t = setup();
    t.socket().events.message({ data });
    assert.equal(t.socket().readyState, 3);
  }
  const t = setup();
  t.welcome();
  t.socket().readyState = 3;
  t.reaction.events.click();
  assert.equal(t.socket().sent.length, 1);
  t.message({ type: "unrecognized" });
  t.socket().events.error();
  assert.match(t.status.textContent, /Unable to connect/);
  const auto = setup();
  globalThis.window = auto.env;
  try {
    await import(`${import.meta.resolve("quick-presenter-audience-web")}?bootstrap-test`);
  } finally {
    delete globalThis.window;
  }
});

test("exported join page supplies Anonymous and the shared keyboard/status wording", () => {
  const html = readFileSync(
    new URL(import.meta.resolve("quick-presenter-audience-web/index.html")),
    "utf8",
  );
  for (const text of [
    'value="Anonymous"',
    "Enter to send · Shift+Enter for a new line",
    "Send a reaction to the presenter.",
    ">Quick Presenter</h1>",
    ">Send</button>",
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Comments appear as plain text|Name \(optional\)/);
});

const validWelcome = {
  protocol: "qp.audience",
  version: "1",
  type: "welcome",
  connection_id: "a1",
  capabilities: ["comments", "reactions"],
  available: true,
  limits: { max_message_bytes: 4096, request_cache_ms: 30000 },
};
const serverCases = [];
for (const key of Object.keys(validWelcome)) {
  const value = structuredClone(validWelcome);
  delete value[key];
  serverCases.push([`missing ${key}`, value]);
}
for (const [key, values] of Object.entries({
  connection_id: [null, 1, "", "a!", "a".repeat(65)],
  capabilities: [null, {}, [1], [""], ["a".repeat(65)], ["x", "x"]],
  available: [null, 1, "true"],
  limits: [
    null,
    [],
    {},
    { max_message_bytes: 4096 },
    { request_cache_ms: 1 },
    { max_message_bytes: 4097, request_cache_ms: 1 },
    ...[0, 60001, 1.5, "1"].map((request_cache_ms) => ({
      max_message_bytes: 4096,
      request_cache_ms,
    })),
  ],
}))
  for (const value of values)
    serverCases.push([
      `invalid ${key} ${JSON.stringify(value)}`,
      { ...validWelcome, [key]: value },
    ]);
for (const value of [
  validWelcome,
  { protocol: "qp.audience", version: "1", type: "state", revision: "1", available: true },
  {
    protocol: "qp.audience",
    version: "1",
    type: "result",
    request_id: "1",
    status: "accepted",
  },
]) {
  serverCases.push([`extra ${value.type}`, { ...value, extra: true }]);
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    delete missing[key];
    serverCases.push([`missing ${value.type}.${key}`, missing]);
  }
}
serverCases.push([
  "nested extra",
  { ...validWelcome, limits: { ...validWelcome.limits, extra: true } },
]);
for (const revision of [1, "01", "-1", "1".repeat(21)])
  serverCases.push([
    "invalid revision",
    { protocol: "qp.audience", version: "1", type: "state", revision, available: true },
  ]);
for (const status of [null, "invalid", "rate_limited"])
  serverCases.push([
    "invalid result",
    { protocol: "qp.audience", version: "1", type: "result", request_id: "1", status },
  ]);
for (const [name, value] of serverCases)
  test(`server schema rejects ${name}`, () => {
    assert.equal(validate("messages", value), false);
    const t = setup();
    t.welcome();
    t.submit("Keep");
    t.socket().events.message({ data: JSON.stringify(value) });
    assert.equal(t.socket().readyState, 3);
    assert(t.send.disabled);
    assert(t.reaction.disabled);
    assert.equal(t.field.value, "Keep");
    assert.notEqual(t.feedback.textContent, "Comment received.");
    t.retry.events.click();
    t.welcome();
    assert.equal(t.socket().sent.length, 1);
  });

test("raw duplicate decoded keys fail before authentication or receipt handling", () => {
  const welcome = JSON.stringify(validWelcome);
  for (const data of [
    welcome.replace('"available":true', '"available":false,"available":true'),
    welcome.replace('"available":true', '"available":true,"available":true'),
    welcome.replace('"available":true', '"availab\\u006ce":true,"available":true'),
    welcome.replace('"request_cache_ms":30000', '"request_cache_ms":30000,"request_cache_ms":1'),
    '{"protocol":"qp.audience","version":"1","type":"result","request_id":"1","status":"busy","status":"accepted"}',
    '{"protocol":"qp.audience","version":"1","type":"state","revision":"1","available":false,"available":true}',
    " ".repeat(4097),
    new Uint8Array([1]),
    `${"[".repeat(33)}0${"]".repeat(33)}`,
  ])
    for (const pending of [false, true]) {
      const t = setup();
      if (pending) {
        t.welcome();
        t.submit("Keep");
      }
      t.socket().events.message({ data });
      assert.equal(t.socket().readyState, 3);
      assert(t.send.disabled);
      if (pending) assert.equal(t.field.value, "Keep");
    }
});

test("valid boundary values and extensible capability strings connect", () => {
  for (const request_cache_ms of [1, 60000])
    for (const capabilities of [[], ["future", "😀".repeat(64)]]) {
      const t = setup();
      t.socket().readyState = 1;
      t.socket().events.message({
        data: JSON.stringify({
          ...validWelcome,
          capabilities,
          limits: { max_message_bytes: 4096, request_cache_ms },
        }),
      });
      assert.equal(t.send.disabled, false);
      t.submit();
      t.result();
      assert.equal(t.field.value, "");
    }
});

for (const fixture of JSON.parse(
  readFileSync(new URL("../protocol/fixtures/audience-server.json", import.meta.url), "utf8"),
))
  test(`browser contract: ${fixture.name}`, () => {
    const t = setup();
    t.socket().readyState = 1;
    assert.equal(validate("messages", fixture.value), fixture.valid);
    t.socket().events.message({ data: JSON.stringify(fixture.value) });
    assert.equal(t.socket().readyState === 3, !fixture.valid);
    assert.equal(t.send.disabled, !fixture.valid);
  });

test("malformed capability Unicode cannot confirm or replay a pending draft", () => {
  for (const value of ["\ud800", "\udfff", "future_\ud800_feature", "\udfff\ud800"])
    for (const pending of [false, true]) {
      const t = setup();
      if (pending) {
        t.welcome();
        t.submit("Keep");
      }
      const message = { ...validWelcome, capabilities: [value] };
      assert.equal(validate("messages", message), false);
      t.socket().events.message({ data: JSON.stringify(message) });
      assert.equal(t.socket().readyState, 3);
      assert(t.send.disabled);
      assert(t.reaction.disabled);
      if (pending) assert.equal(t.field.value, "Keep");
      assert.notEqual(t.feedback.textContent, "Comment received.");
      t.retry.events.click();
      t.welcome();
      assert.equal(t.socket().sent.length, 1);
    }
});

for (const { name, body } of emojiComments)
  test(`emoji comments preserve browser submission: ${name}`, () => {
    const t = setup();
    t.welcome();
    t.submit(body, emojiHandle);
    assert.equal(t.reports(), 0);
    assert.equal(t.socket().sent.length, 2);
    const message = t.socket().sent[1];
    assert.equal(validate("messages", message), true);
    assert.equal(message.body, body);
    assert.equal(message.handle, emojiHandle);
    t.result();
    assert.equal(t.feedback.textContent, "Comment received.");
    assert.equal(t.field.value, "");
  });
