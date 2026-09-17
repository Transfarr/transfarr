import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { Protocols } from "../../lib/protocols/index.mjs";
import { Store } from "../../lib/store.mjs";
import { createApp } from "../../lib/http.mjs";

const exec = promisify(execFile);

test(
  "protocol settings detect conflicts, restart independently and survive restarts",
  { timeout: 60000 },
  async (t) => {
    const signalCounts = ["SIGTERM", "SIGINT", "SIGQUIT"].map((signal) =>
      process.listenerCount(signal),
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "transfarr-settings-"),
    );
    const root = path.join(directory, "mnt");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "hello.txt"), "settings transfer");
    const store = new Store(path.join(directory, "data"));
    let restored;
    t.after(async () => {
      await store.close();
      await restored?.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await store.ready;
    const reservations = [];
    // Hold distinct ports until all have been allocated, avoiding collisions with other tests.
    for (let i = 0; i < 9; i++) {
      const listener = net.createServer();
      await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
      reservations.push(listener);
    }
    t.after(async () => {
      for (const listener of reservations)
        if (listener.listening)
          await new Promise((resolve) => listener.close(resolve));
    });
    const allocated = reservations.map((listener) => listener.address().port);
    const names = ["smb", "ftp", "ftps", "sftp"];
    const ports = Object.fromEntries(
      names.map((name, index) => [name, allocated[index]]),
    );
    const options = {
      root,
      dataDir: path.join(directory, "data"),
      ports,
      passiveMin: 25000,
      passiveHost: "127.0.0.1",
      httpPort: allocated[8],
    };
    // Leave FTP occupied on startup; other protocols and the web UI must still start.
    for (let i = 0; i < 8; i++)
      if (i !== 1)
        await new Promise((resolve) => reservations[i].close(resolve));
    await new Promise((resolve) => reservations[8].close(resolve));
    let protocols = new Protocols(store, options);
    t.after(() => protocols.stop());
    await protocols.start();
    for (const status of Object.values(protocols.status)) {
      assert.equal(status.enabled, false);
      assert.equal(status.running, false);
      assert.equal(status.conflict, false);
    }
    await store.update((data) => {
      data.folders.push({
        id: "activation",
        name: "Activation",
        path: root,
        protocols: names,
        permissions: {},
      });
    });
    await protocols.refresh();
    const app = createApp(store, protocols, { root, publicDir: directory });
    const server = app.listen(options.httpPort, "0.0.0.0");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${options.httpPort}/api/v1`;
    const headers = {
      "Content-Type": "application/json",
      "X-Transfarr-Request": "1",
    };
    for (const endpoint of ["settings", "settings/ftp/port?port=21"])
      assert.equal((await fetch(`${base}/${endpoint}`)).status, 200);
    let settings = await (await fetch(`${base}/settings`, { headers })).json();
    assert.equal(settings.protocols.ftp.running, false);
    assert.equal(settings.protocols.ftp.conflict, true);
    assert.equal(settings.protocols.smb.running, true);
    assert.equal(settings.protocols.ftps.running, true);
    assert.equal(settings.protocols.sftp.running, true);
    await new Promise((resolve) => reservations[1].close(resolve));
    settings = await (await fetch(`${base}/settings`, { headers })).json();
    assert.equal(settings.protocols.ftp.conflict, false);
    assert.equal(settings.protocols.ftp.available, true);
    const recovered = await fetch(`${base}/settings/ftp`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ port: ports.ftp }),
    });
    assert.equal((await recovered.json()).running, true);

    const user = await (
      await fetch(`${base}/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username: "writer", password: "test-password" }),
      })
    ).json();
    assert.equal(
      (
        await fetch(`${base}/folders`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Files",
            path: root,
            protocols: names,
            permissions: { [user.id]: "write" },
          }),
        })
      ).status,
      201,
    );
    for (const invalid of [0, 65536, 22.5, "22", null])
      assert.equal(
        (
          await fetch(`${base}/settings/ftp`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ port: invalid }),
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await fetch(`${base}/settings/unknown`, {
          method: "PUT",
          headers,
          body: '{"port":1234}',
        })
      ).status,
      400,
    );
    for (const blocked of [ports.smb, options.httpPort, options.passiveMin]) {
      const check = await (
        await fetch(`${base}/settings/ftp/port?port=${blocked}`, { headers })
      ).json();
      assert.equal(check.available, false);
      assert.equal(check.conflict, true);
      assert.equal(
        (
          await fetch(`${base}/settings/ftp`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ port: blocked }),
          })
        ).status,
        409,
      );
      assert.equal(protocols.status.ftp.port, ports.ftp);
      assert.equal(protocols.status.ftp.running, true);
    }
    const blocker = net.createServer();
    await new Promise((resolve) =>
      blocker.listen(allocated[4], "0.0.0.0", resolve),
    );
    t.after(
      () =>
        blocker.listening && new Promise((resolve) => blocker.close(resolve)),
    );
    const conflict = await (
      await fetch(`${base}/settings/smb/port?port=${allocated[4]}`, { headers })
    ).json();
    assert.equal(conflict.conflict, true);
    assert.equal(
      (
        await fetch(`${base}/settings/smb`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ port: allocated[4] }),
        })
      ).status,
      409,
    );
    await new Promise((resolve) => blocker.close(resolve));

    // Keep SFTP connected while reconfiguring the other three listeners.
    const liveSftp = new SftpClient();
    await liveSftp.connect({
      host: "127.0.0.1",
      port: ports.sftp,
      username: "writer",
      password: "test-password",
    });
    t.after(() => liveSftp.end());
    for (const [index, protocol] of names.entries()) {
      const own = await (
        await fetch(
          `${base}/settings/${protocol}/port?port=${ports[protocol]}`,
          { headers },
        )
      ).json();
      assert.equal(own.available, true);
      assert.equal(own.conflict, false);
      const newPort = allocated[index + 4];
      const connected = net.connect(ports[protocol], "127.0.0.1");
      connected.on("error", () => {});
      connected.resume();
      t.after(() => connected.destroy());
      await new Promise(resolve => connected.once("connect", resolve));
      // The TCP handshake can complete before the native accept loop registers it.
      if (protocol === "smb") {
        for (let attempt = 0; attempt < 100 && !(await protocols.smb.connectionCount()); attempt++)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(await protocols.smb.connectionCount());
      }
      const noChange = await fetch(`${base}/settings/${protocol}`, {
        method: "PUT", headers, body: JSON.stringify({ port: ports[protocol] }),
      });
      assert.equal(noChange.status, 200, "Unchanged settings must not interrupt clients or request confirmation");
      const before = JSON.stringify(store.data.settings);
      const blocked = await fetch(`${base}/settings/${protocol}`, {
        method: "PUT", headers, body: JSON.stringify({ port: newPort }),
      });
      assert.equal(blocked.status, 409);
      const confirmation = await blocked.json();
      assert.equal(confirmation.code, "CLIENTS_CONNECTED");
      assert.ok(confirmation.activeClients > 0);
      assert.equal(protocols.status[protocol].port, ports[protocol]);
      assert.equal(JSON.stringify(store.data.settings), before);
      assert.equal(connected.destroyed, false, "Unconfirmed save must leave clients connected");
      const changed = await fetch(`${base}/settings/${protocol}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ port: newPort, disconnectClients: true }),
      });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).running, true);
      assert.equal(protocols.status[protocol].port, newPort);
      if (protocol === "sftp") {
        await assert.rejects(liveSftp.list("/Files"));
        await liveSftp.end();
      }
      await assert.rejects(
        new Promise((resolve, reject) => {
          const client = net.connect(ports[protocol], "127.0.0.1");
          client.once("error", reject);
          client.once("connect", () => {
            client.destroy();
            resolve();
          });
        }),
        { code: "ECONNREFUSED" },
      );
      if (protocol !== "sftp")
        assert.equal(
          (await liveSftp.get("/Files/hello.txt")).toString(),
          "settings transfer",
        );
      if (protocol === "ftp" || protocol === "ftps") {
        const client = new FtpClient(5000);
        try {
          await client.access({
            host: "127.0.0.1",
            port: newPort,
            user: "writer",
            password: "test-password",
            secure: protocol === "ftps" ? "implicit" : false,
            secureOptions: { rejectUnauthorized: false },
          });
          assert.ok(
            (await client.list("/Files")).some(
              (entry) => entry.name === "hello.txt",
            ),
          );
        } finally {
          client.close();
        }
      } else if (protocol === "sftp") {
        const client = new SftpClient();
        try {
          await client.connect({
            host: "127.0.0.1",
            port: newPort,
            username: "writer",
            password: "test-password",
          });
          assert.equal(
            (await client.get("/Files/hello.txt")).toString(),
            "settings transfer",
          );
        } finally {
          await client.end();
        }
      } else {
        const result = await exec(
          "smbclient",
          [
            "//127.0.0.1/Files",
            "-p",
            String(newPort),
            "-U",
            "writer",
            "-c",
            "ls",
          ],
          { env: { ...process.env, PASSWD: "test-password" }, timeout: 10000 },
        );
        assert.match(result.stdout, /hello.txt/);
      }
    }
    const folders = store.data.folders;
    await store.update((data) => {
      data.folders = [];
    });
    await protocols.refresh();
    const offline = await (await fetch(`${base}/settings`, { headers })).json();
    for (const [name, status] of Object.entries(offline.protocols)) {
      assert.equal(status.enabled, false);
      assert.equal(status.running, false);
      assert.equal(status.conflict, false);
      assert.equal(status.error, undefined);
      assert.equal(
        (await protocols.inspect(name, status.port)).available,
        true,
      );
    }
    await store.update((data) => {
      data.folders = folders;
    });
    await protocols.refresh();
    assert.deepEqual(
      ["SIGTERM", "SIGINT", "SIGQUIT"].map((signal) =>
        process.listenerCount(signal),
      ),
      signalCounts,
    );
    await protocols.stop();
    restored = new Store(options.dataDir);
    await restored.ready;
    protocols = new Protocols(restored, {
      ...options,
      ports,
    });
    await protocols.start();
    for (const [index, protocol] of names.entries()) {
      assert.equal(protocols.status[protocol].port, allocated[index + 4]);
      assert.equal(protocols.status[protocol].running, true);
    }
  },
);
