import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";

const exec = promisify(execFile);

test(
  "real FTP, FTPS, SFTP, SMB clients share accounts and enforce permissions",
  { timeout: 120000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "transfarr-integration-"),
    );
    const root = path.join(directory, "mnt");
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, "media"));
    await fs.writeFile(path.join(root, "media", "hello.txt"), "hello");
    await fs.symlink("/etc", path.join(root, "media", "escape"));
    const server = spawn(process.execPath, ["server.mjs"], {
      env: {
        ...process.env,
        PORT: "3300",
        TRANSFARR_DATA_DIR: path.join(directory, "data"),
        TRANSFARR_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout.on("data", (data) => (output += data));
    server.stderr.on("data", (data) => (output += data));
    t.after(async () => {
      server.kill("SIGTERM");
      await new Promise((resolve) => {
        if (server.exitCode !== null) resolve();
        else server.once("exit", resolve);
      });
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(output || "Server startup timed out"));
      }, 30000);
      const timer = setInterval(() => {
        if (output.includes("Transfarr is ready")) {
          clearInterval(timer);
          clearTimeout(timeout);
          resolve();
        } else if (server.exitCode !== null) {
          clearInterval(timer);
          clearTimeout(timeout);
          reject(new Error(output));
        }
      }, 100);
    });
  const base = "http://127.0.0.1:3300/api/v1";
  const logo = await fetch("http://127.0.0.1:3300/logo.png");
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.ok((await logo.arrayBuffer()).byteLength > 1000);
    const headers = {
      "Content-Type": "application/json",
      "X-Transfarr-Request": "1",
    };
    let result;
    const users = [];
    for (const username of ["writer", "reader", "outsider"]) {
      result = await fetch(`${base}/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username, password: "test-password" }),
      });
      assert.equal(result.status, 201);
      users.push(await result.json());
    }
    const folderInput = {
      name: "Media",
      path: path.join(root, "media"),
      protocols: ["smb", "ftp", "ftps", "sftp"],
      permissions: { [users[0].id]: "write", [users[1].id]: "read" },
    };
    result = await fetch(`${base}/folders`, {
      method: "POST",
      headers,
      body: JSON.stringify(folderInput),
    });
    assert.equal(result.status, 201);
    const folder = await result.json();
    const state = await (await fetch(`${base}/state`, { headers })).json();
    for (const status of Object.values(state.protocols))
      assert.equal(status.running, true, output);

    for (const protocol of ["ftp", "ftps"])
      await t.test(
        `${protocol}: write, read-only, bad credentials, symlink confinement`,
        async () => {
          const options = {
            host: "127.0.0.1",
            port: protocol === "ftps" ? 990 : 21,
            secure: protocol === "ftps" ? "implicit" : false,
            secureOptions: { rejectUnauthorized: false },
            user: "writer",
            password: "test-password",
          };
          const client = new FtpClient(5000);
          try {
            await client.access(options);
            assert.ok(
              (await client.list("/")).some((entry) => entry.name === "Media"),
            );
            await client.uploadFrom(
              Readable.from("ftp content"),
              `/Media/${protocol}.txt`,
            );
            let text = "";
            await client.downloadTo(
              new Writable({
                write(chunk, _encoding, done) {
                  text += chunk;
                  done();
                },
              }),
              `/Media/${protocol}.txt`,
            );
            assert.equal(text, "ftp content");
            await client.rename(
              `/Media/${protocol}.txt`,
              `/Media/${protocol}-renamed.txt`,
            );
            await assert.rejects(client.size("/Media/escape/passwd"));
            await client.cd("/Media");
            await client.cdup();
            assert.equal(await client.pwd(), "/");
          } finally {
            client.close();
          }
          const reader = new FtpClient(5000);
          try {
            await reader.access({ ...options, user: "reader" });
            assert.ok(
              (await reader.list("/Media")).some(
                (entry) => entry.name === "hello.txt",
              ),
            );
            await assert.rejects(
              reader.uploadFrom(Readable.from("denied"), "/Media/denied.txt"),
            );
            await assert.rejects(reader.remove("/Media/hello.txt"));
          } finally {
            reader.close();
          }
          const outsider = new FtpClient(5000);
          try {
            await assert.rejects(
              outsider.access({ ...options, user: "outsider" }),
            );
          } finally {
            outsider.close();
          }
          const wrong = new FtpClient(5000);
          try {
            await assert.rejects(
              wrong.access({ ...options, password: "incorrect-password" }),
            );
          } finally {
            wrong.close();
          }
        },
      );

    await t.test(
      "SFTP: round trip, directory operations, permission and escape denial",
      async () => {
        const client = new SftpClient();
        try {
          await client.connect({
            host: "127.0.0.1",
            port: 22,
            username: "writer",
            password: "test-password",
          });
          assert.ok(
            (await client.list("/")).some((entry) => entry.name === "Media"),
          );
          await client.put(Buffer.from("sftp content"), "/Media/sftp.txt");
          assert.equal(
            (await client.get("/Media/sftp.txt")).toString(),
            "sftp content",
          );
          await client.mkdir("/Media/directory");
          await client.rename("/Media/sftp.txt", "/Media/directory/sftp.txt");
          await assert.rejects(client.get("/Media/escape/passwd"));
          await assert.rejects(client.chmod("/Media/hello.txt", 0o777));
          await client.delete("/Media/directory/sftp.txt");
          await client.rmdir("/Media/directory");
        } finally {
          await client.end();
        }
        const reader = new SftpClient();
        try {
          await reader.connect({
            host: "127.0.0.1",
            port: 22,
            username: "reader",
            password: "test-password",
          });
          assert.equal(
            (await reader.get("/Media/hello.txt")).toString(),
            "hello",
          );
          await assert.rejects(
            reader.put(Buffer.from("denied"), "/Media/sftp-denied.txt"),
          );
          await assert.rejects(reader.delete("/Media/hello.txt"));
        } finally {
          await reader.end();
        }
      },
    );

    await t.test(
      "SMB2/3: authenticated signed transfers and per-user access",
      async () => {
        const upload = path.join(directory, "upload.txt");
        await fs.writeFile(upload, "smb content");
        const download = path.join(directory, "download.txt");
        const args = [
          "//127.0.0.1/Media",
          "-p",
          "445",
          "-U",
          "writer",
          "--option=client min protocol=SMB2",
          "--option=client signing=required",
          "-c",
        ];
        const env = { ...process.env, PASSWD: "test-password" };
        for (const username of ["writer", "reader", "outsider"]) {
          const listing = await exec("smbclient", ["-L", "127.0.0.1", "-g", "-U", username,
            "--option=client min protocol=SMB2", "--option=client signing=required"], { env, timeout: 10000 });
          assert.equal(listing.stdout.includes("Disk|Media|"), username !== "outsider", listing.stdout + listing.stderr);
        }

        const transfer = await exec(
          "smbclient",
          [...args, `put ${upload} smb.txt; get smb.txt ${download}`],
          { env, timeout: 10000 },
        );
        assert.ok(
          !transfer.stdout.includes("NT_STATUS"),
          transfer.stdout + transfer.stderr,
        );
        assert.equal(await fs.readFile(download, "utf8"), "smb content");
        const read = await exec(
          "smbclient",
          ["//127.0.0.1/Media", "-p", "445", "-U", "reader", "-c", "ls"],
          { env, timeout: 10000 },
        );
        assert.ok(read.stdout.includes("hello.txt"));
        let denial;
        try {
          denial = await exec(
            "smbclient",
            [
              "//127.0.0.1/Media",
              "-p",
              "445",
              "-U",
              "reader",
              "-c",
              `put ${upload} denied.txt`,
            ],
            { env, timeout: 10000 },
          );
        } catch (error) {
          denial = error;
        }
        assert.match(denial.stdout + denial.stderr, /ACCESS_DENIED/);
        await assert.rejects(
          exec(
            "smbclient",
            ["//127.0.0.1/Media", "-p", "445", "-U", "outsider", "-c", "ls"],
            { env, timeout: 10000 },
          ),
        );
        await assert.rejects(
          exec("smbclient", [...args, "ls"], {
            env: { ...env, PASSWD: "incorrect" },
            timeout: 10000,
          }),
        );
        let escape;
        try {
          escape = await exec(
            "smbclient",
            [...args, `get escape/passwd ${download}`],
            { env, timeout: 10000 },
          );
        } catch (error) {
          escape = error;
        }
        assert.match(escape.stdout + escape.stderr, /NT_STATUS/);
      },
    );

    await t.test("anonymous access is opt-in, isolated, and enforces read/write grants across protocols", async () => {
      const ftp = new FtpClient(5000);
      try {
        await assert.rejects(ftp.access({ host: "127.0.0.1", port: 21, user: "anonymous" }));
      } finally { ftp.close(); }
      const deniedSftp = new SftpClient();
      try {
        await assert.rejects(deniedSftp.connect({ host: "127.0.0.1", port: 22, username: "anonymous", password: "" }));
      } finally { await deniedSftp.end(); }
      await assert.rejects(exec("smbclient", ["-L", "127.0.0.1", "-N", "-U", "%"], { timeout: 10000 }));

      const publicFolders = [];
      for (const [name, access] of [["PublicRead", "read"], ["PublicWrite", "write"]]) {
        const response = await fetch(`${base}/folders`, {
          method: "POST", headers,
          body: JSON.stringify({ ...folderInput, name, permissions: { anonymous: access, [users[1].id]: "read" } }),
        });
        assert.equal(response.status, 201);
        publicFolders.push(await response.json());
      }
      for (const protocol of ["ftp", "ftps"]) {
        const client = new FtpClient(5000);
        try {
          await client.access({ host: "127.0.0.1", port: protocol === "ftp" ? 21 : 990,
            secure: protocol === "ftps" ? "implicit" : false, secureOptions: { rejectUnauthorized: false }, user: "anonymous" });
          assert.deepEqual((await client.list("/")).map(entry => entry.name).sort(), ["PublicRead", "PublicWrite"]);
          assert.ok((await client.list("/PublicRead")).some(entry => entry.name === "hello.txt"));
          await assert.rejects(client.uploadFrom(Readable.from("denied"), "/PublicRead/denied.txt"));
          await assert.rejects(client.list("/Media"));
          await client.uploadFrom(Readable.from("anonymous"), `/PublicWrite/anonymous-${protocol}.txt`);
          await client.remove(`/PublicWrite/anonymous-${protocol}.txt`);
        } finally { client.close(); }
      }
      const anonymous = new SftpClient();
      try {
        await anonymous.connect({ host: "127.0.0.1", port: 22, username: "anonymous", password: "" });
        assert.deepEqual((await anonymous.list("/")).map(entry => entry.name).sort(), ["PublicRead", "PublicWrite"]);
        assert.equal((await anonymous.get("/PublicRead/hello.txt")).toString(), "hello");
        await assert.rejects(anonymous.put(Buffer.from("denied"), "/PublicRead/denied.txt"));
        await assert.rejects(anonymous.list("/Media"));
        await anonymous.put(Buffer.from("anonymous"), "/PublicWrite/anonymous-sftp.txt");
        await anonymous.delete("/PublicWrite/anonymous-sftp.txt");
      } finally { await anonymous.end(); }
      const listing = await exec("smbclient", ["-L", "127.0.0.1", "-g", "-N", "-U", "%"], { timeout: 10000 });
      assert.ok(listing.stdout.includes("Disk|PublicRead|"), listing.stdout + listing.stderr);
      assert.ok(listing.stdout.includes("Disk|PublicWrite|"), listing.stdout + listing.stderr);
      assert.ok(!listing.stdout.includes("Disk|Media|"), listing.stdout + listing.stderr);
      const read = await exec("smbclient", ["//127.0.0.1/PublicRead", "-N", "-U", "%", "-c", "ls"], { timeout: 10000 });
      assert.ok(read.stdout.includes("hello.txt"), read.stdout + read.stderr);
      const upload = path.join(directory, "anonymous-upload.txt");
      await fs.writeFile(upload, "anonymous");
      const write = await exec("smbclient", ["//127.0.0.1/PublicWrite", "-N", "-U", "%", "-c", `put ${upload} anonymous-smb.txt`], { timeout: 10000 });
      assert.ok(!/NT_STATUS/.test(write.stdout + write.stderr), write.stdout + write.stderr);
      assert.equal(await fs.readFile(path.join(root, "media", "anonymous-smb.txt"), "utf8"), "anonymous");
      for (const [share, login] of [["PublicRead", ["-N", "-U", "%"]], ["PublicWrite", ["-U", "reader"]]]) {
        let denial;
        try { denial = await exec("smbclient", [`//127.0.0.1/${share}`, ...login, "-c", `put ${upload} anonymous-denied.txt`],
          { env: { ...process.env, PASSWD: "test-password" }, timeout: 10000 }); }
        catch (error) { denial = error; }
        assert.match(denial.stdout + denial.stderr, /ACCESS_DENIED/);
      }
      await assert.rejects(exec("smbclient", ["//127.0.0.1/Media", "-N", "-U", "%", "-c", "ls"], { timeout: 10000 }));
      // Removing anonymous grants disconnects active clients and rejects reconnects.
      const active = new SftpClient();
      await active.connect({ host: "127.0.0.1", port: 22, username: "anonymous", password: "" });
      try {
        for (const entry of publicFolders) {
          const response = await fetch(`${base}/folders/${entry.id}`, { method: "PUT", headers,
            body: JSON.stringify({ ...entry, permissions: { [users[1].id]: "read" } }) });
          assert.equal(response.status, 200);
        }
        await assert.rejects(active.list("/"));
      } finally { await active.end(); }
      const revoked = new SftpClient();
      try { await assert.rejects(revoked.connect({ host: "127.0.0.1", port: 22, username: "anonymous", password: "" })); }
      finally { await revoked.end(); }
      for (const entry of publicFolders) {
        assert.equal((await fetch(`${base}/folders/${entry.id}`, { method: "DELETE", headers })).status, 200);
      }
    });

    await t.test(
      "access edits revoke active sessions and disabled protocols hide shares",
      async () => {
        const client = new SftpClient();
        await client.connect({
          host: "127.0.0.1",
          port: 22,
          username: "writer",
          password: "test-password",
        });
        result = await fetch(`${base}/folders/${folder.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            ...folderInput,
            protocols: ["sftp"],
            permissions: { [users[1].id]: "read" },
          }),
        });
        assert.equal(result.status, 200);
        await assert.rejects(client.list("/Media"));
        await client.end();
        const ftp = new FtpClient(5000);
        try {
          await assert.rejects(
            ftp.access({
              host: "127.0.0.1",
              port: 21,
              user: "reader",
              password: "test-password",
            }),
          );
        } finally {
          ftp.close();
        }
        await assert.rejects(
          exec(
            "smbclient",
            ["//127.0.0.1/Media", "-p", "445", "-U", "reader", "-c", "ls"],
            {
              env: { ...process.env, PASSWD: "test-password" },
              timeout: 10000,
            },
          ),
        );
        for (const file of ["ftp-renamed.txt", "ftps-renamed.txt", "smb.txt"]) {
          const stat = await fs.stat(path.join(root, "media", file));
          assert.equal(stat.uid, process.getuid());
          assert.equal(stat.gid, process.getgid());
          assert.equal(stat.mode & 0o777, 0o644);
        }
      },
    );
  },
);
