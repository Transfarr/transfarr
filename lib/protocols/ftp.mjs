import FtpSrv from "ftp-srv";
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
          "FTP:",
          error.message ||
            (error.pasv_connection
              ? `Data connection from ${error.pasv_connection} does not match control connection from ${error.cmd_connection}`
              : "Protocol error"),
        );
      },
      child() {
        return this;
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
