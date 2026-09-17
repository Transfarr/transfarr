import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client, enterPassiveModeIPv4 } from "basic-ftp";
import { Store } from "../../lib/store.mjs";
import { startFtp } from "../../lib/protocols/ftp.mjs";

test(
  "passive FTP listeners are persistent, bounded, reusable and reject other peers",
  { timeout: 15000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "transfarr-passive-"),
    );
    const root = path.join(directory, "files");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "hello.txt"), "hello");
    const store = new Store(path.join(directory, "data"));
    t.after(async () => {
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await store.update(async (data) => {
      data.users = [
        {
          id: "test",
          username: "test",
          hash: await store.hash("test-password"),
          encryptedPassword: store.encrypt("test-password"),
        },
      ];
      data.folders = [
        {
          id: "test",
          name: "Files",
          path: root,
          protocols: ["ftp"],
          permissions: { test: "read" },
        },
      ];
    });
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "0.0.0.0", resolve));
    const passivePort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const server = await startFtp({
      store,
      root,
      protocol: "ftp",
      port: 0,
      passiveMin: passivePort,
      passiveMax: passivePort,
      passiveHost: "localhost",
      clients: new Set(),
    });
    t.after(() => server.close());
    // The data port exists before any client sends PASV.
    await new Promise((resolve, reject) => {
      const socket = net.connect(passivePort, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
    });
    const options = {
      host: "127.0.0.1",
      port: server.server.address().port,
      user: "test",
      password: "test-password",
    };
    const first = new Client(3000);
    const second = new Client(3000);
    t.after(() => {
      first.close();
      second.close();
    });
    await first.access(options);
    await second.access(options);
    let reply = await first.send("PASV");
    assert.match(reply.message, /127,0,0,1/); // DNS overrides resolve to a valid PASV IPv4 address.
    await assert.rejects(second.send("EPSV"), (error) => error.code === 425);
    // A different loopback peer must not consume another client's allocation.
    await new Promise((resolve, reject) => {
      const socket = net.connect({
        host: "127.0.0.1",
        port: passivePort,
        localAddress: "127.0.0.2",
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("Unrelated data peer was not rejected"));
      });
      socket.on("error", (error) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.on("close", resolve);
      socket.resume();
    });
    // Repeated PASV on one connection releases its old allocation; LIST works immediately.
    first.prepareTransfer = enterPassiveModeIPv4;
    for (let i = 0; i < 5; i++)
      assert.ok(
        (await first.list("/Files")).some(
          (entry) => entry.name === "hello.txt",
        ),
      );
    reply = await second.send("EPSV");
    assert.match(reply.message, new RegExp(`\\|\\|\\|${passivePort}\\|`));
    assert.ok(
      (await second.list("/Files")).some((entry) => entry.name === "hello.txt"),
    );
    first.close();
    second.close();
    await server.close();
    const released = net.createServer();
    await new Promise((resolve, reject) => {
      released.once("error", reject);
      released.listen(passivePort, "0.0.0.0", resolve);
    });
    await new Promise((resolve) => released.close(resolve));
  },
);
