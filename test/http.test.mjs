import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.mjs";
import { createApp } from "../lib/http.mjs";

test("administration opens without login, validates input and never exposes sharing credentials", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-http-"));
  const root = path.join(directory, "mnt");
  await fs.mkdir(root);
  const store = new Store(path.join(directory, "data"));
  await store.ready;
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const app = createApp(
    store,
    { status: {}, refresh: async () => {} },
    { root, publicDir: directory },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/state`)).status, 200);
  const headers = {
    "Content-Type": "application/json",
    "X-Transfarr-Request": "1",
  };
  for (const endpoint of ["session", "setup", "login", "logout"]) {
    const response = await fetch(`${base}/api/v1/${endpoint}`, { method: endpoint === "session" ? "GET" : "POST", headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  store.data.admin = { username: "legacy", hash: "unused-legacy-hash" };
  assert.equal((await fetch(`${base}/api/v1/state`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/users`, { method: "POST" })).status, 403);
  assert.equal(
    (await fetch(`${base}/api/v1/paths?path=/etc`, { headers })).status,
    403,
  );
  const created = await fetch(`${base}/api/v1/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "alice", password: "alice-password" }),
  });
  assert.equal(created.status, 201);
  const user = await created.json();
  assert.deepEqual(Object.keys(user).sort(), ["id", "username"]);
  for (const username of ["Anonymous", "anonymous", "ANONYMOUS", "aNoNyMoUs", " Anonymous "]) {
    for (const method of ["POST", "PUT"]) {
      const response = await fetch(`${base}/api/v1/users${method === "PUT" ? `/${user.id}` : ""}`, {
        method,
        headers,
        body: JSON.stringify({ username, password: "test-password" }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /reserved/i);
    }
  }
  assert.equal(store.data.users.length, 1);
  assert.equal(store.data.users[0].username, "alice");
  assert.equal(
    (
      await fetch(`${base}/api/v1/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username: "ALICE", password: "alice-password" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/api/v1/users/${user.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ username: "alice2", password: "" }),
      })
    ).status,
    200,
  );
  assert.ok(await store.authenticate("alice2", "alice-password"));
  const response = await fetch(`${base}/api/v1/folders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Files",
      path: root,
      protocols: ["ftp"],
      permissions: { [user.id]: "read", anonymous: "write" },
    }),
  });
  assert.equal(response.status, 201);
  const folder = await response.json();
  assert.equal(
    (
      await fetch(`${base}/api/v1/users/${user.id}`, {
        method: "DELETE",
        headers,
      })
    ).status,
    200,
  );
  assert.deepEqual(store.data.folders[0].permissions, { anonymous: "write" });
  assert.equal(
    (
      await fetch(`${base}/api/v1/folders/${folder.id}`, {
        method: "DELETE",
        headers,
      })
    ).status,
    200,
  );
  assert.ok((await fs.stat(root)).isDirectory());
  const state = JSON.stringify(
    await (await fetch(`${base}/api/v1/state`, { headers })).json(),
  );
  assert.ok(!state.includes("hash"));
  assert.ok(!state.includes("Password"));
  assert.ok(!state.includes("legacy"));
  assert.equal((await fetch(`${base}/api/v1/state`)).status, 200);
});
