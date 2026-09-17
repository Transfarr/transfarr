import ssh2 from "ssh2";
import net from "node:net";
import path from "node:path";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { AccessError, VirtualFilesystem } from "../filesystem.mjs";

const { Server, utils } = ssh2;
const { STATUS_CODE: STATUS, OPEN_MODE: OPEN } = utils.sftp;

export async function startSftp({ store, root, port, hostKey, clients }) {
  const server = new Server(
    { hostKeys: [hostKey], ident: "Transfarr", readyTimeout: 15000 },
    (client, info) => {
      let user;
      const remoteAddress = info.ip;
      client.once("close", () => store.audit?.({ protocol: "sftp", user: user?.username || (user?.id === "anonymous" ? "anonymous" : "Unauthenticated"), action: "Disconnect", remoteAddress, outcome: "info" }));
      client.on("error", () => {});
      client.on("authentication", async (ctx) => {
        let accepted = false;
        try {
          if (
            ctx.username.toLowerCase() === "anonymous" &&
            ["none", "password"].includes(ctx.method)
          ) {
            user = { id: "anonymous" };
          } else {
            if (ctx.method !== "password") return ctx.reject(["password"]);
            user = await store.authenticate(ctx.username, ctx.password);
          }
          if (
            !user ||
            !new VirtualFilesystem(store, user.id, "sftp", root).shares().length
          )
            return ctx.reject();
          ctx.accept();
          accepted = true;
        } catch {
          ctx.reject();
        } finally {
          store.audit?.({ protocol: "sftp", user: ctx.username, action: "Login", remoteAddress,
            outcome: accepted ? "success" : "failure", details: accepted ? "Authentication accepted" : "Authentication rejected" });
        }
      });
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (accept) => {
            const stream = accept();
            const filesystem = new VirtualFilesystem(
              store,
              user.id,
              "sftp",
              root,
            );
            const handles = new Map();
            stream.on("close", () => {
              for (const handle of handles.values())
                handle.file?.close().catch(() => {});
              handles.clear();
            });
            // Serialize requests, including pipelined writes and CLOSE, per session.
            let queue = Promise.resolve();
            for (const event of [
              "REALPATH",
              "STAT",
              "LSTAT",
              "FSTAT",
              "OPENDIR",
              "READDIR",
              "OPEN",
              "CLOSE",
              "READ",
              "WRITE",
              "REMOVE",
              "RMDIR",
              "MKDIR",
              "RENAME",
              "SETSTAT",
              "FSETSTAT",
              "READLINK",
              "SYMLINK",
              "EXTENDED",
            ]) {
              stream.on(event, (id, ...args) => {
                queue = queue
                  .then(async () => {
                    const handle = Buffer.isBuffer(args[0]) ? handles.get(args[0].toString("hex")) : null;
                    const entry = { protocol: "sftp", user: user.username || "anonymous", action: event,
                      remoteAddress, outcome: "success", path: handle?.virtual || (typeof args[0] === "string" && event !== "EXTENDED" ? path.posix.resolve("/", args[0]) : "") };
                    if (event === "RENAME") entry.destination = path.posix.resolve("/", args[1]);
                    const [name, ...parts] = entry.path.split("/").filter(Boolean);
                    const share = store.data.folders.find(folder => folder.name === name);
                    if (share) entry.hostPath = path.join(share.path, ...parts);
                    try {
                      filesystem.shares();
                      let handle;
                      if (
                        [
                          "FSTAT",
                          "READDIR",
                          "CLOSE",
                          "READ",
                          "WRITE",
                          "FSETSTAT",
                        ].includes(event)
                      ) {
                        handle = handles.get(args[0].toString("hex"));
                        if (!handle) throw new AccessError("Invalid handle");
                        if (event !== "CLOSE" && handle.virtual !== "/")
                          await filesystem.resolve(
                            handle.virtual,
                            event === "WRITE",
                          );
                      }
                      if (event === "REALPATH") {
                        const { default: path } = await import("node:path");
                        const value = path.posix.resolve("/", args[0]);
                        if (value !== "/") await filesystem.resolve(args[0]);
                        stream.name(id, [
                          { filename: value, longname: value, attrs: {} },
                        ]);
                      } else if (["STAT", "LSTAT", "FSTAT"].includes(event)) {
                        const stat =
                          event === "FSTAT"
                            ? await handle.file.stat()
                            : await filesystem.stat(args[0]);
                        stream.attrs(id, {
                          mode: stat.mode,
                          uid: stat.uid,
                          gid: stat.gid,
                          size: stat.size,
                          atime: Math.floor(stat.atime.getTime() / 1000),
                          mtime: Math.floor(stat.mtime.getTime() / 1000),
                        });
                      } else if (event === "OPENDIR") {
                        const entries = await filesystem.list(args[0]);
                        const token = randomBytes(16);
                        handles.set(token.toString("hex"), {
                          entries,
                          virtual: args[0],
                        });
                        stream.handle(id, token);
                      } else if (event === "READDIR") {
                        if (!handle.entries.length)
                          return stream.status(id, STATUS.EOF);
                        stream.name(
                          id,
                          handle.entries
                            .splice(0, 100)
                            .map((stat) => ({
                              filename: stat.name,
                              longname: stat.name,
                              attrs: {
                                mode: stat.mode,
                                size: stat.size,
                                uid: stat.uid,
                                gid: stat.gid,
                                atime: Math.floor(stat.atime.getTime() / 1000),
                                mtime: Math.floor(stat.mtime.getTime() / 1000),
                              },
                            })),
                        );
                      } else if (event === "OPEN") {
                        const mode = args[1];
                        let flags =
                          mode & OPEN.WRITE
                            ? mode & OPEN.READ
                              ? constants.O_RDWR
                              : constants.O_WRONLY
                            : constants.O_RDONLY;
                        if (mode & OPEN.APPEND) flags |= constants.O_APPEND;
                        if (mode & OPEN.CREAT) flags |= constants.O_CREAT;
                        if (mode & OPEN.TRUNC) flags |= constants.O_TRUNC;
                        if (mode & OPEN.EXCL) flags |= constants.O_EXCL;
                        const opened = await filesystem.open(args[0], flags);
                        const token = randomBytes(16);
                        handles.set(token.toString("hex"), opened);
                        stream.handle(id, token);
                      } else if (event === "CLOSE") {
                        await handle.file?.close();
                        handles.delete(args[0].toString("hex"));
                        stream.status(id, STATUS.OK);
                      } else if (event === "READ") {
                        const buffer = Buffer.alloc(Math.min(args[2], 262144));
                        const { bytesRead } = await handle.file.read(
                          buffer,
                          0,
                          buffer.length,
                          args[1],
                        );
                        if (bytesRead)
                          stream.data(id, buffer.subarray(0, bytesRead));
                        else stream.status(id, STATUS.EOF);
                        entry.details = `${bytesRead} bytes read at offset ${args[1]}`;
                      } else if (event === "WRITE") {
                        if (!handle.write) throw new AccessError();
                        let offset = 0;
                        while (offset < args[2].length) {
                          const { bytesWritten } = await handle.file.write(
                            args[2],
                            offset,
                            args[2].length - offset,
                            args[1] + offset,
                          );
                          if (!bytesWritten) throw new Error("Write failed");
                          offset += bytesWritten;
                        }
                        stream.status(id, STATUS.OK);
                        entry.details = `${offset} bytes written at offset ${args[1]}`;
                      } else if (event === "REMOVE" || event === "RMDIR") {
                        await filesystem.remove(args[0], event === "RMDIR");
                        stream.status(id, STATUS.OK);
                      } else if (event === "MKDIR") {
                        await filesystem.mkdir(args[0]);
                        stream.status(id, STATUS.OK);
                      } else if (event === "RENAME") {
                        await filesystem.rename(args[0], args[1]);
                        stream.status(id, STATUS.OK);
                      } else if (event === "SETSTAT" || event === "FSETSTAT") {
                        // Never allow chmod/chown. File size and timestamps are safe on writable shares.
                        const attrs = args[1];
                        if (
                          attrs.mode !== undefined ||
                          attrs.uid !== undefined ||
                          attrs.gid !== undefined
                        )
                          throw new AccessError(
                            "Filesystem modes are controlled by the container",
                          );
                        await filesystem.resolve(
                          handle?.virtual || args[0],
                          true,
                        );
                        const file =
                          handle?.file ||
                          (await filesystem.open(args[0], constants.O_WRONLY))
                            .file;
                        try {
                          if (attrs.size !== undefined)
                            await file.truncate(attrs.size);
                          if (
                            attrs.atime !== undefined &&
                            attrs.mtime !== undefined
                          )
                            await file.utimes(attrs.atime, attrs.mtime);
                        } finally {
                          if (!handle) await file.close();
                        }
                        stream.status(id, STATUS.OK);
                      } else {
                        entry.outcome = "failure";
                        entry.details = "Operation unsupported";
                        stream.status(id, STATUS.OP_UNSUPPORTED);
                      }
                    } catch (error) {
                      entry.outcome = "failure";
                      entry.details = error.code || "Operation failed";
                      stream.status(
                        id,
                        error.code === "ENOENT"
                          ? STATUS.NO_SUCH_FILE
                          : error.code === "EACCES"
                            ? STATUS.PERMISSION_DENIED
                            : STATUS.FAILURE,
                      );
                    } finally {
                      store.audit?.(entry);
                    }
                  })
                  .catch(() => {});
              });
            }
          });
        }),
      );
    },
  );
  // Track sockets before the SSH handshake so both confirmation and shutdown
  // include clients that have connected but have not sent their SSH banner yet.
  const listener = net.createServer(socket => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => {});
    server.injectSocket(socket);
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "0.0.0.0", resolve);
  });
  return listener;
}
