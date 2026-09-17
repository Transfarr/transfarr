import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { Store } from "../lib/store.mjs";
import { checkedPath, VirtualFilesystem } from "../lib/filesystem.mjs";

test("accounts persist without plaintext passwords and reject incorrect credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-store-"));
  const store = new Store(root);
  let restored;
  t.after(async () => {
    await store.close();
    await restored?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.update(async (next) => {
    next.users.push({
      id: "one",
      username: "alex",
      hash: await store.hash("test-password"),
      encryptedPassword: store.encrypt("test-password"),
    });
  });
  restored = new Store(root);
  assert.equal(
    (await restored.authenticate("alex", "test-password")).id,
    "one",
  );
  assert.equal(await restored.authenticate("alex", "incorrect"), null);
  assert.equal(await restored.authenticate("missing", "test-password"), null);
  assert.equal(
    restored.decrypt(restored.data.users[0].encryptedPassword),
    "test-password",
  );
  assert.ok(!(await fs.readFile(store.file, "utf8")).includes("test-password"));
  await Promise.all([
    store.update((next) => {
      next.users.push({ ...next.users[0], id: "two", username: "second" });
    }),
    store.update((next) => {
      next.users.push({ ...next.users[0], id: "three", username: "third" });
    }),
  ]);
  assert.equal(store.data.users.length, 3);
});

test("filesystem confines paths, enforces protocol and per-folder access, and uses process ownership", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-fs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "shared"));
  await fs.writeFile(path.join(root, "shared", "hello.txt"), "hello");
  await fs.symlink("/etc", path.join(root, "shared", "escape"));
  const store = {
    data: {
      users: [{ id: "writer" }, { id: "reader" }],
      folders: [
        {
          id: "share",
          name: "Media",
          path: path.join(root, "shared"),
          protocols: ["sftp", "ftp"],
          permissions: { writer: "write", reader: "read" },
        },
      ],
    },
  };
  const writer = new VirtualFilesystem(store, "writer", "sftp", root);
  const reader = new VirtualFilesystem(store, "reader", "sftp", root);
  const anonymous = new VirtualFilesystem(store, "anonymous", "sftp", root);
  assert.deepEqual(await anonymous.list("/"), []);
  store.data.folders[0].permissions.anonymous = "read";
  assert.deepEqual((await anonymous.list("/")).map(entry => entry.name), ["Media"]);
  await assert.rejects(anonymous.open("/Media/hello.txt", constants.O_WRONLY));
  store.data.folders[0].permissions.anonymous = "write";
  await anonymous.mkdir("/Media/anonymous-directory");
  await anonymous.remove("/Media/anonymous-directory", true);
  await assert.rejects(reader.open("/Media/hello.txt", constants.O_WRONLY));
  await assert.rejects(anonymous.resolve("/Media/escape/passwd"));
  delete store.data.folders[0].permissions.anonymous;
  await assert.rejects(anonymous.stat("/Media/hello.txt"));
  assert.deepEqual(
    (await writer.list("/")).map((entry) => entry.name),
    ["Media"],
  );
  assert.deepEqual(
    (await writer.list("/Media")).map((entry) => entry.name),
    ["hello.txt"],
  );
  await assert.rejects(writer.resolve("/Media/escape/passwd"));
  await assert.rejects(writer.resolve("/Media/../secret"));
  await assert.rejects(checkedPath(root, "/etc"));
  await assert.rejects(
    reader.open("/Media/hello.txt", constants.O_WRONLY | constants.O_TRUNC),
  );
  await assert.rejects(reader.mkdir("/Media/new"));
  await assert.rejects(reader.rename("/Media/hello.txt", "/Media/moved.txt"));
  await assert.rejects(reader.remove("/Media/hello.txt"));
  assert.equal(
    (await new VirtualFilesystem(store, "writer", "ftps", root).list("/"))
      .length,
    0,
  );
  const opened = await writer.open(
    "/Media/new.txt",
    constants.O_CREAT | constants.O_WRONLY,
  );
  await opened.file.writeFile("created");
  await opened.file.close();
  const stat = await fs.stat(path.join(root, "shared", "new.txt"));
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o666 & ~process.umask());
  store.data.folders[0].permissions.writer = "read";
  await assert.rejects(writer.open("/Media/new.txt", constants.O_WRONLY));
  store.data.users = [];
  await assert.rejects(writer.list("/"));
});
