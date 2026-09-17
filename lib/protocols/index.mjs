import { createRequire } from "node:module";
import { readFile, writeFile, access } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import net from "node:net";
import selfsigned from "selfsigned";
import { startFtp } from "./ftp.mjs";
import { startSftp } from "./sftp.mjs";
import { checkedPath } from "../filesystem.mjs";

export class Protocols {
  constructor(store, options) {
    this.store = store;
    this.options = { smbDiscoveryPort: 445, ...options };
    this.options.ports = { ...options.ports, ...store.data.settings?.ports };
    this.options.passiveRanges = {
      ftp: { min: options.passiveMin, max: options.passiveMin + 9 },
      ftps: { min: options.passiveMin + 10, max: options.passiveMin + 19 },
      ...store.data.settings?.passiveRanges,
    };
    this.clients = Object.fromEntries(
      ["ftp", "ftps", "sftp", "smbDiscovery"].map((name) => [name, new Set()]),
    );
    this.servers = {};
    this.status = {};
    this.queue = Promise.resolve();
  }

  async start() {
    const { dataDir } = this.options;
    const keyPath = path.join(dataDir, "ssh-host.key");
    try {
      await access(keyPath);
    } catch {
      const pair = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      });
      await writeFile(keyPath, pair.privateKey, { mode: 0o600 });
    }
    const certPath =
      process.env.TRANSFARR_TLS_CERT || path.join(dataDir, "tls.crt");
    const tlsKeyPath =
      process.env.TRANSFARR_TLS_KEY || path.join(dataDir, "tls.key");
    if (!process.env.TRANSFARR_TLS_CERT && !process.env.TRANSFARR_TLS_KEY) {
      try {
        await access(certPath);
        await access(tlsKeyPath);
      } catch {
        const certificate = await selfsigned.generate(
          [{ name: "commonName", value: "Transfarr" }],
          {
            keySize: 3072,
            algorithm: "sha256",
            extensions: [
              {
                name: "subjectAltName",
                altNames: [{ type: 2, value: "localhost" }],
              },
            ],
          },
        );
        await writeFile(tlsKeyPath, certificate.private, { mode: 0o600 });
        await writeFile(certPath, certificate.cert);
      }
    }
    this.tls = {
      key: await readFile(tlsKeyPath),
      cert: await readFile(certPath),
      minVersion: "TLSv1.2",
    };
    this.hostKey = await readFile(keyPath);
    const { SmbBinding } = createRequire(import.meta.url)(
      "../../native/smb/transfarr-smb.node",
    );
    this.smb = new SmbBinding();
    this.auditTimer = setInterval(() => {
      for (const entry of JSON.parse(this.smb.drainLogs()))
        this.store.audit({ ...entry, timestamp: new Date(entry.timestamp).toISOString() });
    }, 250);
    this.auditTimer.unref();
    for (const protocol of ["smb", "ftp", "ftps", "sftp"])
      await this.restart(protocol);
  }

  async checkPort(protocol, port, passiveRange = this.options.passiveRanges[protocol]) {
    const result = { port, ...(passiveRange && { passiveMin: passiveRange.min, passiveMax: passiveRange.max }) };
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { ...result, available: false, conflict: false, message: "Choose a port between 1 and 65535." };
    if (passiveRange && (!["ftp", "ftps"].includes(protocol) ||
      !Number.isInteger(passiveRange.min) || !Number.isInteger(passiveRange.max) ||
      passiveRange.min < 1 || passiveRange.max > 65535 || passiveRange.min > passiveRange.max))
      return { ...result, available: false, conflict: false, message: "Choose passive ports between 1 and 65535, with the start no higher than the end." };

    const ranges = { ...this.options.passiveRanges, ...(passiveRange && { [protocol]: passiveRange }) };
    if (port === this.options.smbDiscoveryPort && this.options.smbDiscovery && protocol !== "smb")
      return { ...result, available: false, conflict: true, message: "Reserved for local macOS SMB discovery." };
    if (port === this.options.httpPort)
      return { ...result, available: false, conflict: true, message: "In use by the web administration interface." };
    for (const [name, range] of Object.entries(ranges)) {
      if (port >= range.min && port <= range.max)
        return { ...result, available: false, conflict: true, message: `Reserved for ${name.toUpperCase()} passive data connections.` };
      if (passiveRange && name !== protocol && passiveRange.min <= range.max && passiveRange.max >= range.min)
        return { ...result, available: false, conflict: true, message: `Passive range overlaps ${name.toUpperCase()} passive data ports.` };
    }
    for (const [name, configuredPort] of Object.entries(this.options.ports)) {
      if (name !== protocol && configuredPort === port)
        return { ...result, available: false, conflict: true, message: `Reserved for ${name.toUpperCase()}.` };
    }
    if (passiveRange) {
      const reserved = {
        ...this.options.ports,
        [protocol]: port,
        "web administration": this.options.httpPort,
        ...(this.options.smbDiscovery && { "local SMB discovery": this.options.smbDiscoveryPort }),
      };
      for (const [name, reservedPort] of Object.entries(reserved)) {
        if (reservedPort >= passiveRange.min && reservedPort <= passiveRange.max)
          return { ...result, available: false, conflict: true, message: `Passive data port ${reservedPort} is reserved for ${name}.` };
      }
    }

    const ports = [port];
    if (passiveRange)
      for (let dataPort = passiveRange.min; dataPort <= passiveRange.max; dataPort++)
        ports.push(dataPort);
    for (const probePort of ports) {
      // Existing listeners are released together when this service restarts.
      const currentRange = this.options.passiveRanges[protocol];
      if (this.status[protocol]?.running && (probePort === this.status[protocol].port ||
        (currentRange && probePort >= currentRange.min && probePort <= currentRange.max))) continue;
      if (protocol === "smb" && probePort === this.options.smbDiscoveryPort && this.smbDiscovery?.listening) continue;
      const checked = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", (error) =>
          resolve({
            available: false,
            conflict: error.code === "EADDRINUSE",
            message: `${probePort === port ? "Port" : "Passive data port"} ${probePort}: ${
              error.code === "EADDRINUSE"
                ? "in use by another service."
                : error.code === "EACCES"
                  ? "permission denied."
                  : "unable to check availability."
            }`,
          }),
        );
        probe.listen(probePort, "0.0.0.0", () =>
          probe.close(() => resolve({ available: true })),
        );
      });
      if (!checked.available) return { ...result, ...checked };
    }
    return {
      ...result,
      available: true,
      conflict: false,
      message: this.status[protocol]?.running && this.status[protocol].port === port
        ? "Online — used by Transfarr." : "Available — not in use.",
    };
  }

  // All reconfiguration is serialized, including changes to users and shares.
  async restart(protocol) {
    const port = this.options.ports[protocol];
    for (const client of this.clients[protocol] || [])
      typeof client.destroy === "function" ? client.destroy() : client.end();
    this.clients[protocol]?.clear();
    if (protocol === "smb") {
      for (const client of this.clients.smbDiscovery) client.destroy();
      this.clients.smbDiscovery.clear();
      if (this.smbDiscovery) {
        await new Promise(resolve => this.smbDiscovery.close(resolve));
        this.smbDiscovery = null;
      }
      await this.smb.stop();
    }
    else if (this.servers[protocol]) {
      if (protocol === "sftp")
        await new Promise((resolve) => this.servers[protocol].close(resolve));
      else await this.servers[protocol].close();
      delete this.servers[protocol];
    }
    const enabled = this.store.data.folders.some((folder) =>
      folder.protocols.includes(protocol),
    );
    this.status[protocol] = { running: false, enabled, port, conflict: false };
    if (!enabled) return;
    const check = await this.checkPort(protocol, port);
    if (!check.available) {
      this.status[protocol] = {
        running: false,
        enabled,
        ...check,
        error: check.message,
      };
      return;
    }
    try {
      if (protocol === "smb") {
        const folders = [];
        for (const folder of this.store.data.folders.filter((folder) =>
          folder.protocols.includes("smb"),
        )) {
          folders.push({
            name: folder.name,
            path: await checkedPath(this.options.root, folder.path),
            anonymous: folder.permissions.anonymous,
            grants: this.store.data.users
              .filter((user) => folder.permissions[user.id])
              .map((user) => ({
                username: user.username,
                write: folder.permissions[user.id] === "write",
              })),
          });
        }
        await this.smb.configure(
          JSON.stringify({
            listen: `0.0.0.0:${port}`,
            users: this.store.data.users.map((user) => ({
              username: user.username,
              password: this.store.decrypt(user.encryptedPassword),
            })),
            folders,
          }),
        );
      } else if (protocol === "sftp") {
        this.servers.sftp = await startSftp({
          store: this.store,
          root: this.options.root,
          port,
          hostKey: this.hostKey,
          clients: this.clients.sftp,
        });
      } else {
        this.servers[protocol] = await startFtp({
          store: this.store,
          root: this.options.root,
          protocol,
          port,
          tls: protocol === "ftps" ? this.tls : undefined,
          passiveMin: this.options.passiveRanges[protocol].min,
          passiveMax: this.options.passiveRanges[protocol].max,
          passiveHost: this.options.passiveHost,
          clients: this.clients[protocol],
        });
      }
      this.status[protocol] = { running: true, enabled, port, conflict: false };
      if (protocol === "smb" && this.options.smbDiscovery && port !== this.options.smbDiscoveryPort) {
        const discovery = { port: this.options.smbDiscoveryPort, running: false, conflict: false };
        this.status.smb.discovery = discovery;
        const available = await this.checkPort("smb", discovery.port);
        if (!available.available) {
          discovery.conflict = available.conflict;
          discovery.error = available.message;
          this.status.smb.conflict = discovery.conflict;
          return;
        }
        // Apple's RPC client drops the custom port. Forward loopback clients
        // to the same native SMB server; authentication and ACLs stay identical.
        // macOS permits unprivileged low-port binding on the wildcard address.
        // Reject non-loopback peers before opening the upstream connection.
        const listener = net.createServer(client => {
          if (!client.remoteAddress?.startsWith("127.")) { client.destroy(); return; }
          const upstream = net.connect(port, "127.0.0.1");
          this.clients.smbDiscovery.add(client);
          this.clients.smbDiscovery.add(upstream);
          client.on("error", () => upstream.destroy());
          upstream.on("error", () => client.destroy());
          client.on("close", () => { upstream.destroy(); this.clients.smbDiscovery.delete(client); });
          upstream.on("close", () => { client.destroy(); this.clients.smbDiscovery.delete(upstream); });
          client.pipe(upstream);
          upstream.pipe(client);
        });
        listener.on("error", error => {
          discovery.running = false;
          discovery.conflict = error.code === "EADDRINUSE";
          discovery.error = `Local SMB discovery on port ${discovery.port}: ${error.code === "EADDRINUSE" ? "in use by another service." : "could not start."}`;
          this.status.smb.conflict = discovery.conflict;
        });
        await new Promise(resolve => {
          listener.once("error", resolve);
          listener.listen(discovery.port, "0.0.0.0", () => { discovery.running = true; resolve(); });
        });
        this.smbDiscovery = listener;
      }
    } catch (error) {
      console.error(
        `${protocol.toUpperCase()} could not start:`,
        error.message,
      );
      const conflict =
        error.code === "EADDRINUSE" ||
        error.cause?.code === "EADDRINUSE" ||
        /address already in use/i.test(error.message);
      this.status[protocol] = {
        running: false,
        enabled,
        port,
        conflict,
        error: conflict
          ? error.message.startsWith("Passive data port")
            ? error.message
            : "In use by another service."
          : "Could not start. Check server logs and folder paths.",
      };
    }
  }

  refresh() {
    const operation = this.queue.then(async () => {
      for (const clients of Object.values(this.clients)) {
        for (const client of clients)
          typeof client.destroy === "function"
            ? client.destroy()
            : client.end();
        clients.clear();
      }
      for (const protocol of ["smb", "ftp", "ftps", "sftp"]) {
        const enabled = this.store.data.folders.some((folder) =>
          folder.protocols.includes(protocol),
        );
        if (
          protocol === "smb" ||
          enabled !== this.status[protocol]?.enabled ||
          (enabled && !this.status[protocol]?.running)
        )
          await this.restart(protocol);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  inspect(protocol, port, passiveRange) {
    const operation = this.queue.then(() => this.checkPort(protocol, port, passiveRange));
    this.queue = operation.catch(() => {});
    return operation;
  }

  settings() {
    const operation = this.queue.then(async () => {
      for (const [protocol, status] of Object.entries(this.status)) {
        if (status.enabled && !status.running) {
          const check = await this.checkPort(protocol, status.port);
          status.conflict = check.conflict;
          status.available = check.available;
          status.error = check.available
            ? "Stopped. Save changes to start this protocol."
            : check.message;
        }
      }
      return {
        protocols: structuredClone(this.status),
        passiveMin: this.options.passiveMin,
        passiveRanges: structuredClone(this.options.passiveRanges),
      };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  configure(protocol, port, disconnectClients = false, passiveRange) {
    const operation = this.queue.then(async () => {
      const range = passiveRange ?? this.options.passiveRanges[protocol];
      const check = await this.checkPort(protocol, port, range);
      if (!check.available) {
        const error = new Error(check.message);
        error.code = "PORT_UNAVAILABLE";
        throw error;
      }
      const changed = this.options.ports[protocol] !== port || (range && (
        range.min !== this.options.passiveRanges[protocol].min ||
        range.max !== this.options.passiveRanges[protocol].max
      ));
      const restart = changed || !this.status[protocol]?.running || Boolean(this.status[protocol]?.discovery?.error);
      if (restart && !disconnectClients) {
        const activeClients = protocol === "smb"
          ? await this.smb.connectionCount()
          : this.clients[protocol].size;
        if (activeClients > 0) {
          const error = new Error(`Saving will disconnect ${activeClients} connected ${protocol.toUpperCase()} client${activeClients === 1 ? "" : "s"}.`);
          error.code = "CLIENTS_CONNECTED";
          error.activeClients = activeClients;
          throw error;
        }
      }
      await this.store.update((next) => {
        next.settings ??= {};
        next.settings.ports ??= {};
        next.settings.ports[protocol] = port;
        if (range) {
          next.settings.passiveRanges ??= {};
          next.settings.passiveRanges[protocol] = { ...range };
        }
      });
      this.options.ports[protocol] = port;
      if (range) this.options.passiveRanges[protocol] = { ...range };
      if (restart)
        await this.restart(protocol);
      return { ...this.status[protocol] };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async stop() {
    await this.queue;
    for (const clients of Object.values(this.clients))
      for (const client of clients)
        typeof client.destroy === "function" ? client.destroy() : client.end();
    if (this.smbDiscovery) {
      await new Promise(resolve => this.smbDiscovery.close(resolve));
      this.smbDiscovery = null;
    }
    await this.smb?.stop();
    clearInterval(this.auditTimer);
    if (this.smb)
      for (const entry of JSON.parse(this.smb.drainLogs()))
        this.store.audit({ ...entry, timestamp: new Date(entry.timestamp).toISOString() });
    for (const [protocol, server] of Object.entries(this.servers)) {
      if (protocol === "sftp")
        await new Promise((resolve) => server.close(resolve));
      else await server.close();
    }
  }
}
