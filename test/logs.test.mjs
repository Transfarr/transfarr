import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.mjs";
import { createApp } from "../lib/http.mjs";

test("protocol history persists, filters literally, paginates during new activity, and excludes web actions", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-logs-"));
  let store = new Store(path.join(directory, "data"));
  await store.ready;
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 4; i++) store.audit({ protocol: i % 2 ? "sftp" : "ftp", user: "alice", action: "Upload", path: `/Files/file${i}${i === 2 ? "100%" : ""}.txt`, outcome: i === 2 ? "failure" : "success", password: "never-save-this" });
  await store.close();
  store = new Store(path.join(directory, "data"));
  await store.ready;
  const app = createApp(store, { status: {}, refresh: async () => {} }, { root: directory, publicDir: directory });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1`;
  const first = await (await fetch(`${url}/logs?limit=2`)).json();
  assert.deepEqual(first.entries.map(row => row.id), [4, 3]);
  assert.equal(first.nextCursor, 3);
  store.audit({ protocol: "smb", user: "bob", action: "Rename", path: "/Files/old", destination: "/Files/new", outcome: "success" });
  const older = await (await fetch(`${url}/logs?limit=2&before=${first.nextCursor}`)).json();
  assert.deepEqual(older.entries.map(row => row.id), [2, 1]);
  assert.equal(older.nextCursor, null);
  const filtered = await (await fetch(`${url}/logs?protocol=ftp&outcome=failure&search=${encodeURIComponent("100%")}`)).json();
  assert.deepEqual(filtered.entries.map(row => row.id), [3]);
  assert.equal((await (await fetch(`${url}/logs?search=%25`)).json()).entries.length, 1);
  assert.equal((await (await fetch(`${url}/logs?search=NEW`)).json()).entries[0].user, "bob");
  for (const query of ["limit=1000", "before=-1", "protocol=web", "outcome=unknown"])
    assert.equal((await fetch(`${url}/logs?${query}`)).status, 400);
  const created = await fetch(`${url}/users`, { method: "POST", headers: { "Content-Type": "application/json", "X-Transfarr-Request": "1" }, body: JSON.stringify({ username: "web-created", password: "web-password" }) });
  assert.equal(created.status, 201);
  await fetch(`${url}/paths`);
  const all = await (await fetch(`${url}/logs`)).json();
  assert.equal(all.entries.length, 5);
  assert.ok(!JSON.stringify(all).includes("password"));
  assert.ok(!JSON.stringify(all).includes("never-save-this"));
  // Simulate a full history using the monotonic ID boundary.
  await store.AuditLog.create({ ...all.entries[0], id: 100000 });
  store.audit({ protocol: "ftp", user: "alice", action: "Logout", outcome: "success" });
  await store.flushAudit();
  assert.equal(await store.AuditLog.findByPk(1), null);
  assert.ok(await store.AuditLog.findByPk(2));
});
