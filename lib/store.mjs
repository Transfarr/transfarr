import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { Sequelize, DataTypes } from "@sequelize/core";
import { SqliteDialect } from "@sequelize/sqlite3";

const scrypt = promisify(scryptCallback);

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "sqlite", "db.sqlite");
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!existsSync(this.file))
      writeFileSync(this.file, "", { mode: 0o600, flag: "wx" });
    const keyFile = path.join(directory, "secret.key");
    if (!existsSync(keyFile))
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyFile);
    this.data = { users: [], folders: [] };
    this.sequelize = new Sequelize({
      dialect: SqliteDialect,
      storage: this.file,
      logging: false,
      pool: { max: 1 },
      hooks: {
        afterConnect(connection) {
          connection.configure("busyTimeout", 5000);
        },
      },
    });
    this.User = this.sequelize.define("User", {
      id: { type: DataTypes.STRING, primaryKey: true },
      username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      hash: { type: DataTypes.TEXT, allowNull: false },
      encryptedPassword: { type: DataTypes.TEXT, allowNull: false },
    }, { timestamps: false });
    this.Folder = this.sequelize.define("Folder", {
      id: { type: DataTypes.STRING, primaryKey: true },
      name: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      path: { type: DataTypes.TEXT, allowNull: false },
      protocols: { type: DataTypes.JSON, allowNull: false },
      permissions: { type: DataTypes.JSON, allowNull: false },
    }, { timestamps: false });
    this.Setting = this.sequelize.define("Setting", {
      key: { type: DataTypes.STRING, primaryKey: true },
      value: { type: DataTypes.JSON, allowNull: false },
    }, { timestamps: false });
    this.ready = (async () => {
      await this.sequelize.query("PRAGMA journal_mode = WAL");
      await this.sequelize.sync();
      this.data = {
        users: (await this.User.findAll()).map(user => user.get({ plain: true })),
        folders: (await this.Folder.findAll()).map(folder => folder.get({ plain: true })),
        settings: Object.fromEntries(
          (await this.Setting.findAll()).map(setting => [setting.key, setting.value]),
        ),
      };
    })();
    this.queue = Promise.resolve();
  }

  async hash(password) {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
  }

  async verify(password, hash) {
    if (typeof password !== "string" || password.length > 1024) return false;
    const [salt, digest] = (
      hash || "0000000000000000:" + "00".repeat(64)
    ).split(":");
    const actual = await scrypt(password, salt, 64);
    return timingSafeEqual(actual, Buffer.from(digest, "hex"));
  }

  encrypt(password) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }

  decrypt(value) {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }

  update(callback) {
    const result = this.queue.then(async () => {
      await this.ready;
      const next = structuredClone(this.data);
      const value = await callback(next);
      await this.sequelize.transaction(async (transaction) => {
        await this.User.destroy({ where: {}, transaction });
        await this.Folder.destroy({ where: {}, transaction });
        await this.Setting.destroy({ where: {}, transaction });
        await this.User.bulkCreate(next.users, { transaction, validate: true });
        await this.Folder.bulkCreate(next.folders, { transaction, validate: true });
        await this.Setting.bulkCreate(
          Object.entries(next.settings || {}).map(([key, value]) => ({ key, value })),
          { transaction, validate: true },
        );
      });
      this.data = next;
      return value;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async authenticate(username, password) {
    await this.ready;
    const user = this.data.users.find((user) => user.username === username);
    if (!(await this.verify(password, user?.hash))) return null;
    // The account may have changed during the password hash operation.
    return user &&
      this.data.users.some(
        (current) => current.id === user.id && current.hash === user.hash,
      )
      ? user
      : null;
  }

  async close() {
    await this.queue;
    try {
      await this.ready;
    } finally {
      await this.sequelize.close();
    }
  }
}
