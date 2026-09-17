import path from "node:path";

const dataDir = path.resolve(
  process.env.TRANSFARR_DATA_DIR || "volumes/local-data",
);
const root = path.resolve(process.env.TRANSFARR_ROOT || "volumes/mnt");
const dockerData = path.resolve("volumes/data");
if (dataDir === dockerData)
  throw new Error(
    "Use a separate local data directory so Docker and native configurations remain independent.",
  );

process.env.TRANSFARR_DATA_DIR = dataDir;
process.env.TRANSFARR_ROOT = root;
if (process.platform === "darwin") process.env.TRANSFARR_SMB_DISCOVERY ??= "true";
await import("../server.mjs");
