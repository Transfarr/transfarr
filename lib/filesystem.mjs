import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export class AccessError extends Error {
  constructor(message = "Permission denied", code = "EACCES") {
    super(message);
    this.code = code;
  }
}

// No protocol can create links or change ownership/modes. Reject existing links,
// including links inside a share, so all adapters have the same path policy.
export async function checkedPath(root, requested, create = false) {
  const base = await fs.realpath(root);
  const lexical = path.resolve(root);
  const absolute = path.resolve(lexical, requested);
  const target =
    absolute === lexical || absolute.startsWith(lexical + path.sep)
      ? path.resolve(base, path.relative(lexical, absolute))
      : absolute;
  if (target !== base && !target.startsWith(base + path.sep))
    throw new AccessError();
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new AccessError("Symbolic links are not shared");
    } catch (error) {
      if (error.code === "ENOENT" && create && i === parts.length - 1)
        return target;
      throw error;
    }
  }
  return target;
}

export class VirtualFilesystem {
  constructor(store, userId, protocol, root) {
    this.store = store;
    this.userId = userId;
    this.protocol = protocol;
    this.root = root;
    this.cwd = "/";
  }

  shares() {
    if (
      this.userId !== "anonymous" &&
      !this.store.data.users.some((user) => user.id === this.userId)
    )
      throw new AccessError();
    return this.store.data.folders.filter(
      (folder) =>
        folder.protocols.includes(this.protocol) &&
        folder.permissions[this.userId],
    );
  }

  async resolve(value, write = false, create = false) {
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.includes("\\") ||
      value.split("/").includes("..")
    )
      throw new AccessError();
    const virtual = path.posix.resolve(this.cwd, value);
    const [name, ...parts] = virtual.split("/").filter(Boolean);
    const share = this.shares().find((folder) => folder.name === name);
    if (
      !share ||
      (write && share.permissions[this.userId] !== "write") ||
      (write && !parts.length)
    )
      throw new AccessError();
    const sharePath = await checkedPath(this.root, share.path);
    return {
      path: await checkedPath(sharePath, parts.join("/"), create),
      virtual,
      share,
    };
  }

  async stat(value) {
    if (path.posix.resolve(this.cwd, value) === "/") {
      this.shares();
      return {
        name: "/",
        mode: constants.S_IFDIR | 0o755,
        size: 0,
        uid: process.getuid?.() || 0,
        gid: process.getgid?.() || 0,
        mtime: new Date(),
        atime: new Date(),
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    const resolved = await this.resolve(value);
    return Object.assign(await fs.stat(resolved.path), {
      name: path.posix.basename(resolved.virtual),
    });
  }

  async list(value = ".") {
    if (path.posix.resolve(this.cwd, value) === "/")
      return Promise.all(
        this.shares().map(async (folder) =>
          Object.assign(await this.stat(`/${folder.name}`), {
            name: folder.name,
          }),
        ),
      );
    const resolved = await this.resolve(value);
    const entries = await fs.readdir(resolved.path, { withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => !entry.isSymbolicLink())
        .map(async (entry) =>
          Object.assign(
            await fs.stat(await checkedPath(resolved.path, entry.name)),
            { name: entry.name },
          ),
        ),
    );
  }

  async open(value, flags) {
    const write = Boolean(
      flags &
      (constants.O_WRONLY |
        constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_TRUNC),
    );
    const resolved = await this.resolve(
      value,
      write,
      Boolean(flags & constants.O_CREAT),
    );
    return {
      file: await fs.open(resolved.path, flags | constants.O_NOFOLLOW, 0o666),
      virtual: resolved.virtual,
      write,
    };
  }

  async mkdir(value) {
    const target = await this.resolve(value, true, true);
    await fs.mkdir(target.path, { mode: 0o777 });
    return target.virtual;
  }
  async remove(value, directory = false) {
    const target = await this.resolve(value, true);
    return directory ? fs.rmdir(target.path) : fs.unlink(target.path);
  }
  async rename(from, to) {
    const source = await this.resolve(from, true);
    const target = await this.resolve(to, true, true);
    if (source.share.id !== target.share.id)
      throw new AccessError("Moves between shares are not supported");
    await fs.rename(source.path, target.path);
  }
}
