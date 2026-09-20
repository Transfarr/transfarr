import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Op, sql } from "@sequelize/core";
import { AccessError, checkedPath } from "./filesystem.mjs";

const username = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  .refine(
    (value) => !["guest", "anonymous"].includes(value.toLowerCase()),
    "This username is reserved",
  );
const password = z.string().min(8).max(1024);
const folderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/)
    .refine(
      (value) =>
        !["ipc$", "admin$"].includes(value.toLowerCase()) &&
        !value.endsWith("."),
      "Invalid share name",
    ),
  path: z.string().min(1),
  protocols: z.array(z.enum(["smb", "ftp", "ftps", "sftp"])).max(4),
  permissions: z.record(z.string(), z.enum(["read", "write"])),
});

export function createApp(
  store,
  protocols,
  { root, publicDir },
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "same-origin");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    );
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-Transfarr-Request") !== "1"
    )
      return res.status(403).json({ error: "Missing request header" });
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/v1/logs", async (req, res) => {
    const query = z.object({
      search: z.string().max(200).default(""),
      protocol: z.enum(["smb", "ftp", "ftps", "sftp"]).optional(),
      outcome: z.enum(["success", "failure", "info"]).optional(),
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    await store.flushAudit();
    const where = {};
    if (query.protocol) where.protocol = query.protocol;
    if (query.outcome) where.outcome = query.outcome;
    if (query.before) where.id = { [Op.lt]: query.before };
    if (query.search) where[Op.or] = ["user", "action", "path", "destination", "hostPath", "remoteAddress", "details"]
      .map(key => sql.where(sql.fn("instr", sql.fn("lower", sql.attribute(key)), query.search.toLowerCase()), Op.gt, 0));
    const rows = await store.AuditLog.findAll({ where, order: [["id", "DESC"]], limit: query.limit + 1, raw: true });
    const entries = rows.slice(0, query.limit);
    res.json({ entries, nextCursor: rows.length > query.limit ? entries.at(-1).id : null, retention: 100000, warning: store.auditError || null });
  });
  app.delete("/api/v1/logs", async (_req, res) => {
    await store.clearAudit();
    res.json({ ok: true });
  });
  app.get("/api/v1/state", (_req, res) =>
    res.json({
      users: store.data.users.map(({ id, username }) => ({ id, username })),
      folders: store.data.folders,
      protocols: protocols.status,
      root,
    }),
  );
  app.get("/api/v1/settings", async (_req, res) =>
    res.json(await protocols.settings()),
  );
  app.get("/api/v1/settings/:protocol/port", async (req, res) => {
    const protocol = z
      .enum(["smb", "ftp", "ftps", "sftp"])
      .parse(req.params.protocol);
    const port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(req.query.port);
    const passiveRange = req.query.passiveMin !== undefined || req.query.passiveMax !== undefined
      ? z.object({ min: z.coerce.number().int().min(1).max(65535), max: z.coerce.number().int().min(1).max(65535) })
        .refine(range => range.min <= range.max, "Passive range start must not exceed its end")
        .parse({ min: req.query.passiveMin, max: req.query.passiveMax })
      : undefined;
    if (passiveRange && !["ftp", "ftps"].includes(protocol))
      return res.status(400).json({ error: "Passive ranges are only available for FTP and FTPS." });
    res.json(await protocols.inspect(protocol, port, passiveRange));
  });
  app.put("/api/v1/settings/:protocol", async (req, res) => {
    const protocol = z
      .enum(["smb", "ftp", "ftps", "sftp"])
      .parse(req.params.protocol);
    const { port, disconnectClients, passiveRange } = z
      .object({
        port: z.number().int().min(1).max(65535),
        disconnectClients: z.boolean().default(false),
        passiveRange: z.object({ min: z.number().int().min(1).max(65535), max: z.number().int().min(1).max(65535) })
          .refine(range => range.min <= range.max, "Passive range start must not exceed its end").optional(),
      })
      .parse(req.body);
    if (passiveRange && !["ftp", "ftps"].includes(protocol))
      return res.status(400).json({ error: "Passive ranges are only available for FTP and FTPS." });
    res.json(await protocols.configure(protocol, port, disconnectClients, passiveRange));
  });
  app.get("/api/v1/paths", async (req, res) => {
    const directory = await checkedPath(
      root,
      z.string().parse(req.query.path || root),
    );
    const entries = await fs.readdir(directory, { withFileTypes: true });
    res.json(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          path: path.join(directory, entry.name) + "/",
          directory: true,
        })),
    );
  });
  app.post("/api/v1/paths", async (req, res) => {
    const input = z
      .object({
        parentPath: z.string(),
        directoryName: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .refine(
            (value) => !/[\\/\x00]/.test(value) && ![".", ".."].includes(value),
          ),
      })
      .parse(req.body);
    const parent = await checkedPath(root, input.parentPath);
    const target = await checkedPath(
      root,
      path.join(parent, input.directoryName),
      true,
    );
    await fs.mkdir(target, { mode: 0o777 });
    res.status(201).json({ path: target + "/", directory: true });
  });
  for (const method of ["post", "put"]) {
    app[method](
      `/api/v1/users${method === "put" ? "/:id" : ""}`,
      async (req, res) => {
        const input = z
          .object({
            username,
            password:
              method === "post"
                ? password
                : z.union([password, z.literal("")]).optional(),
          })
          .parse(req.body);
        const user = await store.update(async (next) => {
          const existing =
            method === "put"
              ? next.users.find((user) => user.id === req.params.id)
              : null;
          if (method === "put" && !existing)
            throw new AccessError("User not found", "ENOENT");
          if (
            next.users.some(
              (user) =>
                user.id !== existing?.id &&
                user.username.toLowerCase() === input.username.toLowerCase(),
            )
          )
            throw new Error("Username already exists");
          const user = existing || { id: randomUUID() };
          user.username = input.username;
          if (input.password) {
            user.hash = await store.hash(input.password);
            user.encryptedPassword = store.encrypt(input.password);
          }
          if (!existing) next.users.push(user);
          return { id: user.id, username: user.username };
        });
        try {
          await protocols.refresh();
        } catch (error) {
          console.error("Protocol update failed:", error.message);
        }
        res.status(method === "post" ? 201 : 200).json(user);
      },
    );
    app[method](
      `/api/v1/folders${method === "put" ? "/:id" : ""}`,
      async (req, res) => {
        const input = folderSchema.parse(req.body);
        input.path = await checkedPath(root, input.path);
        if (!(await fs.stat(input.path)).isDirectory())
          throw new Error("Select a directory");
        const folder = await store.update((next) => {
          const existing =
            method === "put"
              ? next.folders.find((folder) => folder.id === req.params.id)
              : null;
          if (method === "put" && !existing)
            throw new AccessError("Folder not found", "ENOENT");
          if (
            next.folders.some(
              (folder) =>
                folder.id !== existing?.id &&
                folder.name.toLowerCase() === input.name.toLowerCase(),
            )
          )
            throw new Error("Share name already exists");
          if (
            Object.keys(input.permissions).some(
              (id) => id !== "anonymous" && !next.users.some((user) => user.id === id),
            )
          )
            throw new Error("Unknown user");
          const folder = {
            id: existing?.id || randomUUID(),
            ...input,
            protocols: [...new Set(input.protocols)],
          };
          if (existing) Object.assign(existing, folder);
          else next.folders.push(folder);
          return folder;
        });
        try {
          await protocols.refresh();
        } catch (error) {
          console.error("Protocol update failed:", error.message);
        }
        res.status(method === "post" ? 201 : 200).json(folder);
      },
    );
  }
  app.delete("/api/v1/users/:id", async (req, res) => {
    await store.update((next) => {
      if (!next.users.some((user) => user.id === req.params.id))
        throw new AccessError("User not found", "ENOENT");
      next.users = next.users.filter((user) => user.id !== req.params.id);
      for (const folder of next.folders)
        delete folder.permissions[req.params.id];
    });
    try {
      await protocols.refresh();
    } catch (error) {
      console.error("Protocol update failed:", error.message);
    }
    res.json({ ok: true });
  });
  app.delete("/api/v1/folders/:id", async (req, res) => {
    await store.update((next) => {
      if (!next.folders.some((folder) => folder.id === req.params.id))
        throw new AccessError("Folder not found", "ENOENT");
      next.folders = next.folders.filter(
        (folder) => folder.id !== req.params.id,
      );
    });
    try {
      await protocols.refresh();
    } catch (error) {
      console.error("Protocol update failed:", error.message);
    }
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  app.use(express.static(publicDir));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(publicDir, "index.html")),
  );
  app.use((error, _req, res, _next) => {
    const status =
      ["PORT_UNAVAILABLE", "CLIENTS_CONNECTED"].includes(error.code)
        ? 409
        : error instanceof z.ZodError
          ? 400
          : error.code === "EACCES"
            ? 403
            : error.code === "ENOENT"
              ? 404
              : 400;
    res.status(status).json({
      ...(error.code === "CLIENTS_CONNECTED" ? { code: error.code, activeClients: error.activeClients } : {}),
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")
          : error.message,
    });
  });
  return app;
}
