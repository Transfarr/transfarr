import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

test("SMB metadata streams advertise support, persist, and enforce permissions", { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-streams-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-streams-outside-"));
  const { SmbBinding } = createRequire(import.meta.url)(process.env.TRANSFARR_TEST_SMB_BINDING || "../../native/smb/transfarr-smb.node");
  const server = new SmbBinding();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, "base.txt"), "original");
  await fs.mkdir(path.join(directory, "folder"));
  await fs.writeFile(path.join(outside, "secret.txt"), "untouched");
  await fs.symlink(outside, path.join(directory, "escape"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = JSON.stringify({
    listen: `127.0.0.1:${port}`,
    users: ["writer", "reader"].map(username => ({ username, password: "test-password" })),
    folders: [{ name: "Files", path: directory, grants: [{ username: "writer", write: true }, { username: "reader", write: false }] }],
  });
  const python = process.env.TRANSFARR_RPC_PYTHON || "python3";
  await server.configure(config);
  const result = await promisify(execFile)(python, ["test/integration/smb-streams.py", String(port), "write"], { timeout: 25000 });
  t.diagnostic(result.stdout.trim());
  await server.stop();
  await server.configure(config);
  const reopened = await promisify(execFile)(python, ["test/integration/smb-streams.py", String(port), "reopen"], { timeout: 25000 });
  t.diagnostic(reopened.stdout.trim());
  assert.equal(await fs.readFile(path.join(directory, "renamed.txt"), "utf8"), "original");
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "untouched");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["escape", "folder", "renamed.txt"]);
});
