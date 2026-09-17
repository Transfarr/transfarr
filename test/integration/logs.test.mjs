import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import selfsigned from "selfsigned";
import { Client } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { Store } from "../../lib/store.mjs";
import { startFtp } from "../../lib/protocols/ftp.mjs";
import { startSftp } from "../../lib/protocols/sftp.mjs";

test("FTP, FTPS, SFTP and SMB log users, paths, outcomes and renames without credentials or payloads", { timeout: 60000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-protocol-logs-")));
  const root = path.join(directory, "files");
  await fs.mkdir(root);
  const store = new Store(path.join(directory, "data"));
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.update(async data => {
    for (const username of ["writer", "reader"]) data.users.push({ id: username, username, hash: await store.hash("test-password"), encryptedPassword: store.encrypt("test-password") });
    data.folders.push({ id: "files", name: "Files", path: root, protocols: ["ftp", "ftps", "sftp", "smb"], permissions: { writer: "write", reader: "read", anonymous: "read" } });
  });
  const certificate = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { keySize: 2048 });
  for (const protocol of ["ftp", "ftps"]) {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "0.0.0.0", resolve));
    const passivePort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const server = await startFtp({ store, root, protocol, port: 0, tls: protocol === "ftps" ? { key: certificate.private, cert: certificate.cert } : undefined, passiveMin: passivePort, passiveMax: passivePort, passiveHost: "127.0.0.1", clients: new Set() });
    const client = new Client(5000), reader = new Client(5000), bad = new Client(5000);
    try {
      const options = { host: "127.0.0.1", port: server.server.address().port, user: "writer", password: "test-password", secure: protocol === "ftps" ? "implicit" : false, secureOptions: { rejectUnauthorized: false } };
      await client.access(options);
      await client.uploadFrom(Readable.from("private-file-content"), `/Files/${protocol}.txt`);
      await client.downloadTo(new Writable({ write(chunk, encoding, done) { done(); } }), `/Files/${protocol}.txt`);
      await client.rename(`/Files/${protocol}.txt`, `/Files/${protocol}-renamed.txt`);
      await client.remove(`/Files/${protocol}-renamed.txt`);
      await reader.access({ ...options, user: "reader" });
      await assert.rejects(reader.uploadFrom(Readable.from("no"), `/Files/${protocol}-denied.txt`));
      await assert.rejects(bad.access({ ...options, password: "wrong-password" }));
    } finally { client.close(); reader.close(); bad.close(); await server.close(); }
  }
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
  const clients = new Set();
  const sftpServer = await startSftp({ store, root, port: 0, hostKey, clients });
  const sftp = new SftpClient(), reader = new SftpClient(), bad = new SftpClient();
  try {
    const options = { host: "127.0.0.1", port: sftpServer.address().port, username: "writer", password: "test-password" };
    await sftp.connect(options);
    await sftp.put(Buffer.from("private-file-content"), "/Files/sftp.txt");
    await sftp.get("/Files/sftp.txt");
    await sftp.rename("/Files/sftp.txt", "/Files/sftp-renamed.txt");
    await sftp.delete("/Files/sftp-renamed.txt");
    await reader.connect({ ...options, username: "reader" });
    await assert.rejects(reader.put(Buffer.from("no"), "/Files/sftp-denied.txt"));
    await assert.rejects(bad.connect({ ...options, password: "wrong-password", retries: 0 }));
  } finally {
    await Promise.all([sftp.end(), reader.end(), bad.end()]);
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => sftpServer.close(resolve));
  }
  const { SmbBinding } = createRequire(import.meta.url)("../../native/smb/transfarr-smb.node");
  const smb = new SmbBinding();
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  try {
    await smb.configure(JSON.stringify({ listen: `127.0.0.1:${port}`, users: ["writer", "reader"].map(username => ({ username, password: "test-password" })), folders: [{ name: "Files", path: root, grants: [{ username: "writer", write: true }, { username: "reader", write: false }] }] }));
    await promisify(execFile)(process.env.TRANSFARR_RPC_PYTHON || "python3", ["test/integration/logs.py", String(port)], { timeout: 20000 });
  } finally { await smb.stop(); }
  for (const entry of JSON.parse(smb.drainLogs())) store.audit({ ...entry, timestamp: new Date(entry.timestamp).toISOString() });
  await store.flushAudit();
  const entries = await store.AuditLog.findAll({ raw: true });
  for (const protocol of ["ftp", "ftps", "sftp", "smb"]) {
    const rows = entries.filter(row => row.protocol === protocol);
    assert.ok(rows.some(row => row.user === "writer" && row.outcome === "success" && row.path === `/Files/${protocol === "smb" ? "smb-upload" : protocol}.txt`), `${protocol}: successful file action`);
    assert.ok(rows.some(row => row.user === "reader" && row.outcome === "failure" && row.path === `/Files/${protocol}-denied.txt`), `${protocol}: denied upload`);
    assert.ok(rows.some(row => row.user === "writer" && row.outcome === "failure" && row.action === "Login"), `${protocol}: failed login`);
    assert.ok(rows.some(row => row.destination === `/Files/${protocol}-renamed.txt` && row.outcome === "success"), `${protocol}: rename destination`);
    assert.ok(rows.some(row => row.hostPath.startsWith(root + path.sep)), `${protocol}: server path`);
    assert.ok(rows.every(row => row.remoteAddress.includes("127.0.0.1")), `${protocol}: client IP`);
  }
  for (const secret of ["test-password", "wrong-password", "private-file-content"]) assert.ok(!JSON.stringify(entries).includes(secret), secret);
});
