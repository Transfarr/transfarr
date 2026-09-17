import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.mjs";

test("SQLite starts empty without importing JSON and persists users, folders and settings", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-sqlite-"));
  const legacy = '{"users":[{"id":"legacy"}],"folders":[],"settings":{"ports":{"ftp":1234}}}';
  await fs.writeFile(path.join(directory, "transfarr.json"), legacy);
  let store = new Store(directory);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.ready;
  assert.deepEqual(store.data, { users: [], folders: [], settings: {} });
  await store.update(async (data) => {
    data.users.push({ id: "alice", username: "alice", hash: await store.hash("test-password"), encryptedPassword: store.encrypt("test-password") });
    data.folders.push({ id: "files", name: "Files", path: directory, protocols: ["smb", "ftp"], permissions: { alice: "write", anonymous: "read" } });
    data.settings = { ports: { smb: 1445, ftp: 2121, ftps: 9990, sftp: 2222 } };
  });
  const snapshot = structuredClone(store.data);
  const database = store.file;
  await store.close();
  store = new Store(directory);
  await store.ready;
  assert.deepEqual(store.data, snapshot);
  assert.equal((await store.authenticate("alice", "test-password")).id, "alice");
  assert.equal(store.decrypt(store.data.users[0].encryptedPassword), "test-password");
  assert.equal(await fs.readFile(path.join(directory, "transfarr.json"), "utf8"), legacy);
  const bytes = await fs.readFile(database);
  assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
  assert.ok(!bytes.includes(Buffer.from("test-password")));
  assert.equal((await fs.stat(database)).mode & 0o777, 0o600);
});

test("failed SQLite transactions roll back all tables and subsequent queued updates succeed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-sqlite-rollback-"));
  const store = new Store(directory);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.update(async (data) => {
    data.users.push({ id: "alice", username: "alice", hash: await store.hash("test-password"), encryptedPassword: store.encrypt("test-password") });
    data.settings = { ports: { ftp: 2121 } };
  });
  const snapshot = structuredClone(store.data);
  await assert.rejects(store.update(data => {
    data.users[0].username = "changed";
    data.settings.ports.ftp = 9999;
    // Duplicate folder names fail after user changes have been written in the transaction.
    data.folders = ["first", "second"].map(id => ({ id, name: "Duplicate", path: directory, protocols: ["ftp"], permissions: { anonymous: "read" } }));
  }));
  assert.deepEqual(store.data, snapshot);
  const restored = new Store(directory);
  try {
    await restored.ready;
    assert.deepEqual(restored.data, snapshot);
  } finally { await restored.close(); }
  await Promise.all([
    store.update(data => { data.settings.ports.sftp = 2222; }),
    store.update(data => { data.settings.ports.ftps = 9990; }),
  ]);
  assert.deepEqual(store.data.settings.ports, { ftp: 2121, sftp: 2222, ftps: 9990 });
});
