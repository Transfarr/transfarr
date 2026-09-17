import fs from "node:fs/promises";
import path from "node:path";
import { Store } from "./lib/store.mjs";
import { Protocols } from "./lib/protocols/index.mjs";
import { createApp } from "./lib/http.mjs";

await fs.mkdir(
  path.resolve(process.env.TRANSFARR_DATA_DIR || "./volumes/data"),
  { recursive: true, mode: 0o700 },
);
await fs.mkdir(path.resolve(process.env.TRANSFARR_ROOT || "./volumes/mnt"), {
  recursive: true,
});
const dataDir = await fs.realpath(
  process.env.TRANSFARR_DATA_DIR || "./volumes/data",
);
const root = await fs.realpath(process.env.TRANSFARR_ROOT || "./volumes/mnt");
if (
  dataDir === root ||
  dataDir.startsWith(root + path.sep) ||
  root.startsWith(dataDir + path.sep)
)
  throw new Error("The data directory and shared root must be separate");
process.umask(parseInt(process.env.TRANSFARR_UMASK || "0022", 8));
const store = new Store(dataDir);
await store.ready;
const protocols = new Protocols(store, {
  root,
  dataDir,
  ports: {
    smb: Number(process.env.TRANSFARR_SMB_PORT || 445),
    ftp: Number(process.env.TRANSFARR_FTP_PORT || 21),
    ftps: Number(process.env.TRANSFARR_FTPS_PORT || 990),
    sftp: Number(process.env.TRANSFARR_SFTP_PORT || 22),
  },
  httpPort: Number(process.env.PORT || 3000),
  smbDiscovery: process.platform === "darwin" && process.env.TRANSFARR_SMB_DISCOVERY === "true",
  passiveMin: Number(process.env.TRANSFARR_PASSIVE_MIN || 50000),
  passiveHost: process.env.TRANSFARR_PUBLIC_HOST || "127.0.0.1",
});
try {
  await protocols.start();
} catch (error) {
  console.error("Protocol startup failed:", error);
  await protocols.stop();
  await store.close();
  process.exit(1);
}
const app = createApp(store, protocols, {
  root,
  publicDir: path.resolve("public"),
});
const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("Transfarr is ready."),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    server.close();
    await protocols.stop();
    await store.close();
    process.exit(0);
  });
