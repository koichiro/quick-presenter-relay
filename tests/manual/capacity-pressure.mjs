// SPDX-License-Identifier: Apache-2.0
// Explicit loopback diagnostics; never part of the automatic CI workload.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { startRelay } from "../../dist/src/runtime.js";
import { connectRuntime, reaction, receipt } from "../runtime-helpers.mjs";

const token = "A".repeat(43);
const duration = Number(process.env.RELAY_DIAGNOSTIC_MS ?? 5000);
assert(
  Number.isSafeInteger(duration) && duration >= 5000 && duration <= 120000,
  "RELAY_DIAGNOSTIC_MS must be an integer from 5000 through 120000",
);

if (process.argv[2] === "--runtime") {
  const database = process.argv[3];
  const runtime = await startRelay({
    database,
    storageKey: Buffer.alloc(32, 1),
    createToken: token,
    publicOrigin: "https://relay.example",
  });
  process.send({ port: runtime.port });
  process.on("message", async (message) => {
    if (message === "sample") {
      const size = async (path) =>
        (
          await stat(path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return { size: 0 };
          })
        ).size;
      process.send({
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        heap: getHeapStatistics(),
        counts: runtime.diagnostics(),
        sqliteBytes: await size(database),
        walBytes: await size(`${database}-wal`),
      });
    } else if (message === "stop") {
      await runtime.stop();
      process.disconnect();
    }
  });
} else {
  test("bounded Node capacity, TCP pressure, isolation and recovery", {
    timeout: duration * 2 + 60000,
  }, async (t) => {
    await mkdir("coverage/capacity", { recursive: true });
    const report = { complete: false, node: process.version, durationMs: duration, profiles: [] };
    const save = () =>
      writeFile("coverage/capacity/report.json", `${JSON.stringify(report, null, 2)}\n`);
    await save();
    for (const audienceSize of [100, 300]) {
      const dir = await mkdtemp(join(tmpdir(), "relay-node-capacity-"));
      const child = fork(fileURLToPath(import.meta.url), ["--runtime", join(dir, "rooms.sqlite")], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        execArgv: [],
      });
      const exited = once(child, "exit");
      const clients = [];
      const cleanup = async () => {
        for (const client of clients) client.ws.terminate();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await rm(dir, { recursive: true, force: true });
      };
      t.after(cleanup);
      try {
        const [{ port }] = await once(child, "message");
        const base = `http://127.0.0.1:${port}`;
        const sample = async () => {
          const next = once(child, "message", { signal: AbortSignal.timeout(10000) });
          child.send("sample");
          return (await next)[0];
        };
        let sequence = 0;
        const create = async () => {
          const response = await fetch(`${base}/api/relay/v1/rooms`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ idempotency_key: `diagnostic-${sequence++}` }),
          });
          assert.equal(response.status, 201);
          return response.json();
        };
        const connect = async (config, role) => {
          const client = await connectRuntime(base, config, role);
          const next = client.next;
          client.next = async (type) => {
            const controller = new AbortController();
            try {
              return await Promise.race([
                next(type),
                delay(10000, undefined, { signal: controller.signal, ref: false }).then(() => {
                  throw new Error("Diagnostic message deadline exceeded");
                }),
              ]);
            } finally {
              controller.abort();
            }
          };
          clients.push(client);
          return client;
        };
        const end = async (config) => {
          const response = await fetch(`${base}/api/relay/v1/rooms/${config.room_id}/end`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.presenter_token}` },
          });
          assert.equal(response.status, 200);
        };
        const healthy = await create();
        const presenter = await connect(healthy, "presenter");
        const members = [];
        for (let offset = 0; offset < audienceSize; offset += 8)
          members.push(
            ...(await Promise.all(
              Array.from({ length: Math.min(8, audienceSize - offset) }, () =>
                connect(healthy, "audience"),
              ),
            )),
          );
        const pressures = [];
        for (const role of ["presenter", "audience"]) {
          const config = await create();
          const p = await connect(config, "presenter");
          const a = await connect(config, "audience");
          const unread = role === "presenter" ? p : a;
          // Disable the helper's retained message array for this deliberately unread transport.
          unread.ws.removeAllListeners("message");
          unread.ws.pause();
          pressures.push({ config, p, a, unread, role });
        }
        const profile = {
          audienceSize,
          accepted: 0,
          pressureFrames: 0,
          rounds: 0,
          maxResultMs: 0,
          peakRss: 0,
          peakHeapUsed: 0,
          peakExternal: 0,
          peakWalBytes: 0,
          recovered: 0,
          samples: 0,
          initial: await sample(),
        };
        report.profiles.push(profile);
        await save();
        const observe = async () => {
          const value = await sample();
          assert.equal(value.counts.failedRooms, 0);
          profile.samples++;
          profile.peakRss = Math.max(profile.peakRss, value.memory.rss);
          profile.peakHeapUsed = Math.max(profile.peakHeapUsed, value.memory.heapUsed);
          profile.peakExternal = Math.max(profile.peakExternal, value.memory.external);
          profile.peakWalBytes = Math.max(profile.peakWalBytes, value.walBytes);
          profile.latest = value;
          await save();
        };
        const started = performance.now();
        while (performance.now() - started < duration) {
          // Bounded bursts distinguish pressure from unlimited producer allocation.
          for (const pressure of pressures) {
            if (pressure.a.ws.readyState !== 1) continue;
            for (let index = 0; index < 16; index++) {
              pressure.a.send({
                type: "comment",
                request_id: pressure.role === "audience" ? "unread" : `${profile.rounds}-${index}`,
                body: "界".repeat(200),
                handle: "Synthetic",
              });
              profile.pressureFrames++;
              if (pressure.role === "audience" && profile.rounds === 0 && index === 0) {
                const event = await pressure.p.next("event");
                pressure.p.send(receipt(event));
              }
            }
            pressure.p.messages.length = 0;
            pressure.a.messages.length = 0;
          }
          for (let offset = 0; offset < members.length; offset += 16) {
            const batch = members.slice(offset, offset + 16);
            const time = performance.now();
            for (const member of batch) member.send(reaction(`healthy-${profile.rounds}`));
            for (let index = 0; index < batch.length; index++) {
              presenter.send(receipt(await presenter.next("event")));
            }
            for (const member of batch)
              assert.equal((await member.next("result")).status, "accepted");
            profile.accepted += batch.length;
            profile.maxResultMs = Math.max(profile.maxResultMs, performance.now() - time);
          }
          presenter.messages.length = 0;
          profile.rounds++;
          await observe();
          // Stay below 256 distinct requests per identity in the 30-second cache.
          await delay(200);
        }
        assert(profile.rounds >= 2);
        for (const pressure of pressures) {
          pressure.p.ws.terminate();
          pressure.a.ws.terminate();
          await Promise.all([pressure.p.closed, pressure.a.closed]);
          // Wait for server membership cleanup before the replacement audience joins.
          for (let tries = 0; ; tries++) {
            const counts = (await sample()).counts;
            if (
              counts.connections <=
              audienceSize + 1 + (pressures.length - profile.recovered - 1) * 2
            )
              break;
            assert(tries < 100);
            await delay(20);
          }
          const freshP = await connect(pressure.config, "presenter");
          const freshA = await connect(pressure.config, "audience");
          freshA.send(reaction("recovery"));
          const event = await freshP.next("event");
          assert.equal(event.request_id, "recovery");
          freshP.send(receipt(event));
          assert.equal((await freshA.next("result")).status, "accepted");
          await end(pressure.config);
          await Promise.all([freshP.closed, freshA.closed]);
          assert.equal(
            freshP.messages.some((message) => message.type === "event"),
            false,
          );
          profile.recovered++;
        }
        await end(healthy);
        await Promise.all([presenter.closed, ...members.map((member) => member.closed)]);
        for (let tries = 0; ; tries++) {
          const value = await sample();
          if (value.counts.connections === 0) {
            profile.final = value;
            break;
          }
          assert(tries < 100);
          await delay(20);
        }
        assert.equal(profile.final.counts.pending, 0);
        assert.equal(profile.final.counts.requests, 0);
        assert.equal(profile.final.counts.failedRooms, 0);
        await observe();
        child.send("stop");
        assert.equal((await exited)[0], 0);
        await save();
      } finally {
        await cleanup();
      }
    }
    report.complete = true;
    await save();
  });
}
