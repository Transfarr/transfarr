import FtpSrv from "ftp-srv";
import fs from "node:fs/promises";
import { bindPassivePorts } from "./passive.mjs";
import {
  constants,
  realpathSync,
  lstatSync,
  openSync,
  createWriteStream,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AccessError, VirtualFilesystem } from "../filesystem.mjs";

export class FtpFilesystem extends VirtualFilesystem {
  currentDirectory() {
    return this.cwd;
  }
  get(value) {
    return this.stat(value);
  }
  async chdir(value) {
    const next = path.posix.resolve(this.cwd, value);
    const stat = await this.stat(next);
    if (!stat.isDirectory())
      throw new AccessError("Not a directory", "ENOTDIR");
    this.cwd = next;
    return this.cwd;
  }
  async mkdir(value, { recursive = false } = {}) {
    if (!recursive) return super.mkdir(value);
    // Validate the entire input before creating any of its parent directories.
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.includes("\\") ||
      value.split("/").includes("..")
    )
      throw new AccessError();
    const virtual = path.posix.resolve(this.cwd, value);
    const [name, ...parts] = virtual.split("/").filter(Boolean);
    let current = `/${name}`;
    // A share must already exist and be writable, even for an existing path.
    const share = this.shares().find((folder) => folder.name === name);
    if (!share || share.permissions[this.userId] !== "write")
      throw new AccessError();
    if (!(await this.stat(current)).isDirectory())
      throw new AccessError("Not a directory", "ENOTDIR");
    for (const part of parts) {
      current += `/${part}`;
      const target = await this.resolve(current, true, true);
      try {
        await fs.mkdir(target.path, { mode: 0o777 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      // Recheck existing directories and reject files or symbolic links.
      if (!(await this.stat(current)).isDirectory())
        throw new AccessError("Not a directory", "ENOTDIR");
    }
    return virtual;
  }
  async read(value, { start = 0 } = {}) {
    const opened = await this.open(value, constants.O_RDONLY);
    return {
      stream: opened.file.createReadStream({ start, autoClose: true }),
      clientPath: opened.virtual,
    };
  }
  write(value, { append = false, start = 0 } = {}) {
    // The FTP library's STOR/APPE contract requires a synchronous stream.
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.split("/").includes("..")
    )
      throw new AccessError();
    const virtual = path.posix.resolve(this.cwd, value);
    const [name, ...parts] = virtual.split("/").filter(Boolean);
    const share = this.shares().find((folder) => folder.name === name);
    if (!share || share.permissions[this.userId] !== "write" || !parts.length)
      throw new AccessError();
    const base = realpathSync(this.root);
    const target = path.resolve(share.path, ...parts);
    if (!target.startsWith(base + path.sep)) throw new AccessError();
    const segments = path.relative(base, target).split(path.sep);
    let current = base;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new AccessError();
      } catch (error) {
        if (error.code !== "ENOENT" || i !== segments.length - 1) throw error;
      }
    }
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      (append ? constants.O_APPEND : start ? 0 : constants.O_TRUNC);
    const fd = openSync(target, flags | constants.O_NOFOLLOW, 0o666);
    return {
      stream: createWriteStream(target, {
        fd,
        start: append ? undefined : start,
        autoClose: true,
      }),
      clientPath: virtual,
    };
  }
  async delete(value) {
    return this.remove(value, (await this.stat(value)).isDirectory());
  }
  chmod() {
    throw new AccessError("Filesystem modes are controlled by the container");
  }
  getUniqueName() {
    return randomUUID();
  }
}

export async function startFtp({
  store,
  root,
  protocol,
  port,
  tls,
  passiveMin,
  passiveMax,
  passiveHost,
  clients,
}) {
  const signalListeners = new Map(
    ["SIGTERM", "SIGINT", "SIGQUIT"].map((signal) => [
      signal,
      new Set(process.listeners(signal)),
    ]),
  );
  const server = new FtpSrv({
    url: `${protocol === "ftps" ? "ftps" : "ftp"}://0.0.0.0:${port}`,
    anonymous: true,
    tls,
    pasv_min: passiveMin,
    pasv_max: passiveMax,
    timeout: 120000,
    pasv_url: passiveHost,
    greeting: "Transfarr",
    blacklist: ["SITE", "ALLO", "PORT", "EPRT"],
    log: {
      info() {},
      debug() {},
      trace() {},
      warn() {},
      error(error) {
        console.error(
          this.directive ? `FTP ${this.directive}:` : "FTP:",
          error.message ||
            (error.pasv_connection
              ? `Data connection from ${error.pasv_connection} does not match control connection from ${error.cmd_connection}`
              : "Protocol error"),
        );
      },
      child(fields = {}) {
        return Object.assign(Object.create(this), fields);
      },
    },
  });
  // Transfarr owns process shutdown. ftp-srv installs exit handlers per instance.
  for (const [signal, previous] of signalListeners)
    for (const listener of process.listeners(signal))
      if (!previous.has(listener)) process.removeListener(signal, listener);
  // Await socket closure without ftp-srv's uncancelled two-minute timeout per client.
  server.disconnectClient = async function (id) {
    const connection = this.connections[id];
    if (!connection) return;
    delete this.connections[id];
    await connection.close(0);
  };
  server.server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });
  server.on("connect", ({ connection }) => {
    const activity = new AsyncLocalStorage();
    const reply = connection.reply.bind(connection);
    connection.reply = (code, ...messages) => {
      const entry = activity.getStore();
      if (entry) entry.code = code;
      return reply(code, ...messages);
    };
    const remoteAddress = connection.commandSocket.remoteAddress;
    connection.commandSocket.once("close", () => store.audit?.({
      protocol, user: connection.auditUsername || "Unauthenticated", action: "Disconnect",
      remoteAddress, outcome: "info",
    }));
    const handle = connection.commands.handle.bind(connection.commands);
    connection.commands.handle = async (input) => {
      const command =
        typeof input === "string" ? connection.commands.parse(input) : input;
      if (command.directive === "USER") connection.auditUsername = command.arg;
      const labels = { PASS: "Login", USER: "Select user", RETR: "Download", STOR: "Upload", STOU: "Upload unique file", APPE: "Append", DELE: "Delete file", RMD: "Remove directory", XRMD: "Remove directory", MKD: "Create directory", XMKD: "Create directory", RNFR: "Rename from", RNTO: "Rename", LIST: "List directory", NLST: "List directory", MLSD: "List directory", CWD: "Change directory", CDUP: "Parent directory", PWD: "Working directory", SIZE: "File size", MDTM: "File modified time", QUIT: "Logout" };
      const entry = {
        protocol, user: connection.auditUsername || "Unauthenticated",
        action: labels[command.directive] || (/^[A-Z]{3,5}$/.test(command.directive) ? command.directive : "Unknown command"),
        remoteAddress, outcome: "failure",
      };
      if (["RETR", "STOR", "STOU", "APPE", "DELE", "RMD", "XRMD", "MKD", "XMKD", "RNFR", "RNTO", "LIST", "NLST", "MLSD", "MLST", "CWD", "XCWD", "CDUP", "XCUP", "PWD", "XPWD", "SIZE", "MDTM"].includes(command.directive)) {
        entry.path = path.posix.resolve(connection.fs?.cwd || "/", command.arg || ".");
        if (command.directive === "RNTO") {
          entry.destination = entry.path;
          entry.path = path.posix.resolve(connection.fs?.cwd || "/", connection.renameFrom || ".");
        }
        const [name, ...parts] = entry.path.split("/").filter(Boolean);
        const share = store.data.folders.find(folder => folder.name === name);
        if (share) entry.hostPath = path.join(share.path, ...parts);
      }
      return activity.run(entry, async () => {
        try {
          // ftp-srv maps every LIST/NLST filesystem error to 451. Missing or
          // inaccessible paths need 550 so clients can create them and retry.
          if (
            connection.authenticated &&
            connection.fs &&
            ["LIST", "NLST"].includes(command.directive)
          ) {
            try {
              await connection.fs.get(command.arg || ".");
            } catch (error) {
              if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) {
                connection.connector.end();
                connection.log.child({ directive: command.directive }).error(error);
                return connection.reply(550, "Path unavailable");
              }
            }
          }
          return await handle(input);
        } finally {
          entry.outcome = entry.code >= 200 && entry.code < 400 ? "success" : "failure";
          entry.details = entry.code ? `FTP reply ${entry.code}` : "Connection ended before command completed";
          store.audit?.(entry);
        }
      });
    };
  });
  server.on(
    "login",
    async ({ connection, username, password }, resolve, reject) => {
      try {
        const user = username.toLowerCase() === "anonymous"
          ? { id: "anonymous" }
          : await store.authenticate(username, password);
        if (!user) throw new AccessError("Invalid username or password");
        const filesystem = new FtpFilesystem(store, user.id, protocol, root);
        if (!filesystem.shares().length)
          throw new AccessError("No shared folders available");
        resolve({ fs: filesystem });
      } catch (error) {
        reject(error);
      }
    },
  );
  server.on("client-error", () => {});
  await bindPassivePorts(server, {
    passiveMin,
    passiveMax,
    passiveHost,
    tls,
    clients,
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
