import { test } from "node:test";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { Protocols } from "../../lib/protocols/index.mjs";

test("SMB discovery lists only authorized shares using real RPC clients", { timeout: 90000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-discovery-"));
  const { SmbBinding } = createRequire(import.meta.url)(process.env.TRANSFARR_TEST_SMB_BINDING || "../../native/smb/transfarr-smb.node");
  const server = new SmbBinding();
  t.after(async () => { await server.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = {
    listen: `127.0.0.1:${port}`,
    users: ["reader", "other", "empty", "many"].map(username => ({ username, password: "test-password" })),
    folders: [
      { name: "Shared", path: directory, grants: [{ username: "reader", write: false }] },
      { name: "Café", path: directory, grants: [{ username: "reader", write: false }] },
      { name: "Private", path: directory, grants: [{ username: "other", write: true }] },
      ...Array.from({ length: 250 }, (_, i) => ({ name: `Share-${String(i).padStart(4, "0")}`, path: directory, grants: [{ username: "many", write: false }] })),
    ],
  };
  await server.configure(JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.env.TRANSFARR_RPC_PYTHON || "python3", ["test/integration/smb-discovery.py", String(port)], { timeout: 80000 });
  t.diagnostic(stdout.trim());
  await server.stop();
  server.drainLogs();
  const aliasProbe = net.createServer();
  await new Promise(resolve => aliasProbe.listen(0, "0.0.0.0", resolve));
  const aliasPort = aliasProbe.address().port;
  const activity = [];
  const store = {
    data: {
      users: config.users.map(user => ({ id: user.username, username: user.username, encryptedPassword: user.password })),
      folders: config.folders.map(folder => ({ ...folder, protocols: ["smb"], permissions: Object.fromEntries(folder.grants.map(grant => [grant.username, grant.write ? "write" : "read"])) })),
    },
    decrypt: value => value,
    audit: entry => activity.push(entry),
  };
  store.data.folders.push({ name: "FTP-only", path: directory, protocols: ["ftp"], permissions: { reader: "read" } });
  const protocols = new Protocols(store, { root: directory, ports: { smb: port }, httpPort: 0, passiveMin: 65000, smbDiscovery: true, smbDiscoveryPort: aliasPort });
  protocols.smb = server;
  t.after(async () => {
    await protocols.stop();
    assert.ok(activity.some(entry => entry.protocol === "smb" && entry.action === "Login" && entry.user === "reader" && entry.outcome === "success"));
    assert.deepEqual(JSON.parse(server.drainLogs()), []);
  });
  await protocols.restart("smb");
  assert.equal(protocols.status.smb.running, true);
  assert.equal(protocols.status.smb.discovery.running, false);
  assert.equal(protocols.status.smb.conflict, true);
  await new Promise(resolve => aliasProbe.close(resolve));
  await protocols.restart("smb");
  assert.equal(protocols.status.smb.discovery.running, true);
  assert.equal(protocols.status.smb.conflict, false);
  assert.equal((await protocols.checkPort("ftp", aliasPort)).available, false);
  await promisify(execFile)(process.env.TRANSFARR_RPC_PYTHON || "python3", ["test/integration/smb-discovery.py", String(aliasPort)], { timeout: 80000 });
  const oldSession = net.connect(aliasPort, "127.0.0.1");
  oldSession.on("error", error => { assert.equal(error.code, "ECONNRESET"); });
  await new Promise(resolve => oldSession.once("connect", resolve));
  const disconnected = new Promise(resolve => oldSession.once("close", resolve));
  for (const folder of store.data.folders) folder.protocols = [];
  await protocols.restart("smb");
  await disconnected;
  assert.equal(protocols.status.smb.enabled, false);
  assert.equal(protocols.smbDiscovery, null);
  const released = net.createServer();
  await new Promise((resolve, reject) => { released.once("error", reject); released.listen(aliasPort, "0.0.0.0", resolve); });
  await new Promise(resolve => released.close(resolve));
  t.diagnostic("Local discovery listener: conflict visibility, recovery, disabled-protocol filtering, and socket cleanup passed.");
});
