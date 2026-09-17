import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { Client, enterPassiveModeIPv4 } from "basic-ftp";
import { FtpFilesystem, startFtp } from "../lib/protocols/ftp.mjs";

test("FTP recursive directories preserve share permissions and path confinement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-ftp-fs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "backups"));
  await fs.mkdir(path.join(root, "outside"));
  await fs.symlink(path.join(root, "outside"), path.join(root, "backups", "link"));
  await fs.writeFile(path.join(root, "backups", "file"), "content");
  const store = {
    data: {
      users: [{ id: "writer" }, { id: "reader" }],
      folders: [{
        id: "backups", name: "Backups", path: path.join(root, "backups"),
        protocols: ["ftp", "ftps"], permissions: { writer: "write", reader: "read" },
      }],
    },
  };
  for (const protocol of ["ftp", "ftps"]) {
    const writer = new FtpFilesystem(store, "writer", protocol, root);
    const reader = new FtpFilesystem(store, "reader", protocol, root);
    await writer.chdir("/Backups");
    const target = `Reolink/${protocol}/2026/09/17`;
    assert.deepEqual(
      await Promise.all(Array.from({ length: 3 }, () => writer.mkdir(target, { recursive: true }))),
      Array(3).fill(`/Backups/${target}`),
    );
    assert.ok((await fs.stat(path.join(root, "backups", target))).isDirectory());
    await assert.rejects(reader.mkdir(`/Backups/${target}`, { recursive: true }), { code: "EACCES" });
    for (const invalid of ["/Missing/new", "/Backups/link/new/deep", "/Backups/new/../escape", "/Backups/bad\\path/new", "/Backups/bad\0path/new"])
      await assert.rejects(writer.mkdir(invalid, { recursive: true }), { code: "EACCES" });
    await assert.rejects(writer.mkdir("file/child", { recursive: true }), { code: "ENOTDIR" });
    await assert.rejects(writer.mkdir("nonrecursive/child"), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(path.join(root, "outside")), []);
    await assert.rejects(fs.stat(path.join(root, "backups", "new")), { code: "ENOENT" });
  }
});

test("FTP missing directory replies allow nested MKD and a dated camera upload", { timeout: 15000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-ftp-camera-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = {
    data: {
      users: [{ id: "writer" }, { id: "reader" }],
      folders: [{
        id: "backups", name: "Backups", path: root,
        protocols: ["ftp"], permissions: { writer: "write", reader: "read" },
      }],
    },
    async authenticate(username, password) {
      return password === "test-password" ? this.data.users.find(user => user.id === username) : null;
    },
  };
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "0.0.0.0", resolve);
  });
  const passivePort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let server;
  const client = new Client(3000);
  const reader = new Client(3000);
  t.after(async () => {
    client.close();
    reader.close();
    await server?.close();
  });
  server = await startFtp({
    store, root, protocol: "ftp", port: 0,
    passiveMin: passivePort, passiveMax: passivePort,
    passiveHost: "127.0.0.1", clients: new Set(),
  });
  const options = {
    host: "127.0.0.1", port: server.server.address().port,
    user: "writer", password: "test-password",
  };
  await client.access(options);
  client.prepareTransfer = enterPassiveModeIPv4;
  await client.cd("/Backups");
  await assert.rejects(client.cd("Reolink/2026/09"), { code: 550 });
  await assert.rejects(client.list("Reolink/2026/09"), { code: 550 });
  await assert.rejects(client.send("NLST Reolink/2026/09"), { code: 550 });
  const created = await client.send("MKD Reolink/2026/09/17");
  assert.equal(created.code, 257);
  assert.match(created.message, /"\/Backups\/Reolink\/2026\/09\/17"/);
  assert.equal((await client.send("MKD Reolink/2026/09/17")).code, 257);
  await client.cd("Reolink/2026/09/17");
  await client.uploadFrom(Readable.from("camera recording"), "recording.mp4");
  await client.appendFrom(Readable.from(" appended"), "recording.mp4");
  assert.equal(await fs.readFile(path.join(root, "Reolink/2026/09/17/recording.mp4"), "utf8"), "camera recording appended");
  assert.deepEqual((await client.list()).map(entry => entry.name), ["recording.mp4"]);
  await reader.access({ ...options, user: "reader" });
  await assert.rejects(reader.send("MKD /Backups/denied/nested"), { code: 550 });
  await assert.rejects(reader.send("MKD /Backups/Reolink/2026/09/17"), { code: 550 });
});
