import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { Client } from "basic-ftp";
import { Protocols } from "../lib/protocols/index.mjs";
import { Store } from "../lib/store.mjs";
import { createApp } from "../lib/http.mjs";

test("passive ranges validate, reconfigure independently, protect connected clients and persist", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transfarr-ranges-"));
  const root = path.join(directory, "files");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "passive settings");
  let store = new Store(path.join(directory, "data"));
  let protocols;
  const reservations = [];
  const clients = [];
  let server;
  t.after(async () => {
    for (const client of clients) client.close();
    await protocols?.stop();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const listener of reservations)
      if (listener.listening) await new Promise(resolve => listener.close(resolve));
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.ready;
  // Allocate separate control ports and three contiguous two-port data ranges.
  for (let i = 0; i < 6; i++) {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, "0.0.0.0", resolve));
    reservations.push(listener);
  }
  const allocated = reservations.map(listener => listener.address().port);
  const ranges = [];
  while (ranges.length < 3) {
    const first = net.createServer();
    await new Promise(resolve => first.listen(0, "0.0.0.0", resolve));
    const min = first.address().port;
    const second = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        second.once("error", reject);
        second.listen(min + 1, "0.0.0.0", resolve);
      });
      reservations.push(first, second);
      ranges.push({ min, max: min + 1 });
    } catch {
      await new Promise(resolve => first.close(resolve));
    }
  }
  const options = {
    root, dataDir: path.join(directory, "data"),
    ports: { ftp: allocated[0], ftps: allocated[1], smb: allocated[2], sftp: allocated[3] },
    httpPort: allocated[4], passiveMin: 25000, passiveHost: "127.0.0.1",
    smbDiscovery: true, smbDiscoveryPort: allocated[5],
  };
  protocols = new Protocols(store, options);
  assert.deepEqual((await protocols.settings()).passiveRanges, {
    ftp: { min: 25000, max: 25009 }, ftps: { min: 25010, max: 25019 },
  });
  await store.update(data => {
    data.settings.passiveRanges = { ftp: ranges[0], ftps: ranges[1] };
  });
  protocols = new Protocols(store, options);
  for (const listener of reservations)
    await new Promise(resolve => listener.close(resolve));
  server = createApp(store, protocols, { root, publicDir: directory }).listen(options.httpPort, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${options.httpPort}/api/v1/settings`;
  const headers = { "Content-Type": "application/json", "X-Transfarr-Request": "1" };

  for (const passiveRange of [{ min: 0, max: 10 }, { min: 10, max: 65536 }, { min: 20, max: 19 },
    { min: 1.5, max: 3 }, { min: "1", max: 3 }, { min: 1 }, null]) {
    const response = await fetch(`${base}/ftp`, {
      method: "PUT", headers, body: JSON.stringify({ port: options.ports.ftp, passiveRange }),
    });
    assert.equal(response.status, 400);
  }
  for (const suffix of ["passiveMin=1", "passiveMin=2&passiveMax=1", "passiveMin=0&passiveMax=2"]) {
    assert.equal((await fetch(`${base}/ftp/port?port=${options.ports.ftp}&${suffix}`)).status, 400);
  }
  assert.equal((await fetch(`${base}/sftp`, {
    method: "PUT", headers, body: JSON.stringify({ port: options.ports.sftp, passiveRange: ranges[2] }),
  })).status, 400);
  const before = structuredClone(store.data.settings);
  for (const passiveRange of [ranges[1], ...allocated.map(port => ({ min: port, max: port }))]) {
    const response = await fetch(`${base}/ftp`, {
      method: "PUT", headers, body: JSON.stringify({ port: options.ports.ftp, passiveRange }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /overlaps|reserved/i);
    assert.deepEqual(store.data.settings, before);
  }
  const blocker = net.createServer();
  reservations.push(blocker);
  await new Promise(resolve => blocker.listen(ranges[2].max, "0.0.0.0", resolve));
  const occupied = await (await fetch(`${base}/ftp/port?port=${options.ports.ftp}&passiveMin=${ranges[2].min}&passiveMax=${ranges[2].max}`)).json();
  assert.equal(occupied.available, false, "Even unused protocols must check all proposed data ports");
  assert.match(occupied.message, new RegExp(String(ranges[2].max)));
  assert.equal((await fetch(`${base}/ftp`, {
    method: "PUT", headers, body: JSON.stringify({ port: options.ports.ftp, passiveRange: ranges[2] }),
  })).status, 409);
  assert.deepEqual(store.data.settings, before);
  await new Promise(resolve => blocker.close(resolve));

  await store.update(data => {
    data.folders = [{ id: "files", name: "Files", path: root, protocols: ["ftp", "ftps"], permissions: { anonymous: "read" } }];
  });
  const certificate = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { keySize: 2048 });
  protocols.tls = { key: certificate.private, cert: certificate.cert };
  await protocols.restart("ftp");
  await protocols.restart("ftps");
  for (const name of ["ftp", "ftps"]) {
    assert.equal(protocols.status[name].running, true);
    const client = new Client(3000);
    clients.push(client);
    await client.access({ host: "127.0.0.1", port: options.ports[name], user: "anonymous", password: "",
      secure: name === "ftps" ? "implicit" : false, secureOptions: { rejectUnauthorized: false } });
    assert.ok((await client.list("/Files")).some(entry => entry.name === "hello.txt"));
  }

  for (const [index, name] of ["ftp", "ftps"].entries()) {
    const original = protocols.options.passiveRanges[name];
    // FTP shrinks within its live range; FTPS moves to a separate single-port range.
    const target = index === 0 ? { min: original.min, max: original.min } : { min: ranges[2].min, max: ranges[2].min };
    const otherServer = protocols.servers[index === 0 ? "ftps" : "ftp"];
    const client = clients[index];
    assert.equal((await protocols.inspect(name, options.ports[name], target)).available, true);
    const unchanged = await fetch(`${base}/${name}`, {
      method: "PUT", headers, body: JSON.stringify({ port: options.ports[name], passiveRange: original }),
    });
    assert.equal(unchanged.status, 200);
    assert.ok((await client.list("/Files")).length);
    const saved = structuredClone(store.data.settings);
    const blocked = await fetch(`${base}/${name}`, {
      method: "PUT", headers, body: JSON.stringify({ port: options.ports[name], passiveRange: target }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "CLIENTS_CONNECTED");
    assert.deepEqual(store.data.settings, saved);
    assert.ok((await client.list("/Files")).length, "Unconfirmed change leaves transfers working");
    const changed = await fetch(`${base}/${name}`, {
      method: "PUT", headers, body: JSON.stringify({ port: options.ports[name], passiveRange: target, disconnectClients: true }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).running, true);
    assert.equal(protocols.servers[index === 0 ? "ftps" : "ftp"], otherServer);
    if (index === 0) assert.ok((await clients[1].list("/Files")).length, "FTPS remains connected");
    await assert.rejects(client.list("/Files"));
    await client.access({ host: "127.0.0.1", port: options.ports[name], user: "anonymous", password: "",
      secure: name === "ftps" ? "implicit" : false, secureOptions: { rejectUnauthorized: false } });
    assert.match((await client.send("EPSV")).message, new RegExp(`\\|\\|\\|${target.min}\\|`));
    assert.ok((await client.list("/Files")).length);
    const released = net.createServer();
    await new Promise((resolve, reject) => {
      released.once("error", reject);
      released.listen(original.max, "0.0.0.0", resolve);
    });
    await new Promise(resolve => released.close(resolve));
  }
  // Old API clients that save only the control port must preserve saved ranges.
  const persisted = structuredClone(protocols.options.passiveRanges);
  await protocols.configure("ftp", options.ports.ftp);
  assert.deepEqual(protocols.options.passiveRanges, persisted);
  for (const client of clients) client.close();
  await protocols.stop();
  await store.close();
  store = new Store(options.dataDir);
  await store.ready;
  protocols = new Protocols(store, { ...options, passiveMin: 30000 });
  protocols.tls = { key: certificate.private, cert: certificate.cert };
  assert.deepEqual((await protocols.settings()).passiveRanges, persisted);
  for (const name of ["ftp", "ftps"]) {
    await protocols.restart(name);
    assert.equal(protocols.status[name].running, true);
  }
});
