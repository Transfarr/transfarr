import net from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";

// ftp-srv's transfer handlers use Bluebird's .tap() and TimeoutError APIs.
const require = createRequire(import.meta.resolve("ftp-srv"));
const Promise = require("bluebird");
const BaseConnector = require("ftp-srv/src/connector/base.js");

class PassiveTransfer {
  constructor(connection, slot) {
    this.connection = connection;
    this.slot = slot;
    this.type = "passive";
    this.socket = null;
    slot.transfer = this;
    this.ready = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.ready.catch(() => {});
    this.timer = setTimeout(() => this.end(), 30000);
    this.timer.unref();
  }

  waitForConnection() {
    return this.ready.timeout(5000);
  }

  end() {
    clearTimeout(this.timer);
    this.reject(new Promise.TimeoutError("Passive connection closed"));
    if (this.slot.transfer === this) this.slot.transfer = null;
    if (this.connection.connector === this)
      this.connection.connector = new BaseConnector(this.connection);
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.end(() => socket.destroy());
  }
}

export async function bindPassivePorts(
  server,
  { passiveMin, passiveMax, passiveHost, tls: tlsOptions, clients },
) {
  const slots = [];
  // Bind for the lifetime of FTP, so Docker desktop forwarding is ready before PASV.
  try {
    for (let port = passiveMin; port <= passiveMax; port++) {
      const slot = { port, transfer: null, pending: new Map() };
      const connected = (socket) => {
        const key = `${socket.remoteAddress}:${socket.remotePort}`;
        const transfer = slot.pending.get(key);
        slot.pending.delete(key);
        if (!transfer || slot.transfer !== transfer || transfer.socket) {
          socket.destroy();
          return;
        }
        transfer.socket = socket;
        clearTimeout(transfer.timer);
        socket.on("error", () => transfer.end());
        socket.once("close", () => transfer.end());
        transfer.resolve(socket);
      };
      slot.server = tlsOptions
        ? tls.createServer(
            { ...tlsOptions, pauseOnConnect: true, handshakeTimeout: 5000 },
            connected,
          )
        : net.createServer({ pauseOnConnect: true }, connected);
      slot.server.prependListener("connection", (socket) => {
        const transfer = slot.transfer;
        const key = `${socket.remoteAddress}:${socket.remotePort}`;
        clients.add(socket);
        socket.once("close", () => {
          clients.delete(socket);
          slot.pending.delete(key);
        });
        // Keep the control/data peer check: another client cannot take this transfer.
        if (
          !transfer ||
          transfer.socket ||
          slot.pending.size ||
          socket.remoteAddress?.replace(/^::ffff:/, "") !==
            transfer.connection.commandSocket.remoteAddress?.replace(
              /^::ffff:/,
              "",
            )
        ) {
          socket.destroy();
          return;
        }
        slot.pending.set(key, transfer);
      });
      slots.push(slot);
      await new Promise((resolve, reject) => {
        slot.server.once("error", reject);
        slot.server.listen(port, "0.0.0.0", resolve);
      });
    }
  } catch (error) {
    await Promise.all(
      slots.map((slot) => new Promise((resolve) => slot.server.close(resolve))),
    );
    throw new Error(
      `Passive data port ${slots.at(-1)?.port}: ${error.message}`,
      { cause: error },
    );
  }

  server.on("connect", ({ connection }) => {
    const handle = connection.commands.handle.bind(connection.commands);
    connection.commands.handle = async (input) => {
      const command =
        typeof input === "string" ? connection.commands.parse(input) : input;
      if (!["PASV", "EPSV"].includes(command.directive)) return handle(input);
      if (!connection.authenticated)
        return connection.reply(530, "Sign in first");
      if (command.directive === "EPSV" && command.arg?.toUpperCase() === "ALL")
        return connection.reply(200, "EPSV supported");
      if (command.directive === "EPSV" && command.arg && command.arg !== "1")
        return connection.reply(522, "Use IPv4 (1)");
      connection.connector.end();
      const slot = slots.find((slot) => !slot.transfer);
      if (!slot)
        return connection.reply(
          425,
          "All passive data ports are busy. Try again.",
        );
      const transfer = new PassiveTransfer(connection, slot);
      connection.connector = transfer;
      try {
        if (command.directive === "EPSV")
          return await connection.reply(
            229,
            `Entering Extended Passive Mode (|||${slot.port}|)`,
          );
        let address =
          passiveHost ||
          connection.commandSocket.localAddress?.replace(/^::ffff:/, "");
        if (!net.isIPv4(address))
          address = (await lookup(address, { family: 4 })).address;
        return await connection.reply(
          227,
          `Entering Passive Mode (${address.replace(/\./g, ",")},${slot.port >> 8},${slot.port & 255})`,
        );
      } catch (error) {
        transfer.end();
        return connection.reply(425, "Could not prepare a passive connection");
      }
    };
  });

  const close = server.close.bind(server);
  server.close = async () => {
    for (const slot of slots) slot.transfer?.end();
    for (const socket of clients) socket.destroy();
    await Promise.all(
      slots.map((slot) => new Promise((resolve) => slot.server.close(resolve))),
    );
    return close();
  };
}
