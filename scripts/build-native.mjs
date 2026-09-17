import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
const env = { ...process.env };
if (existsSync("volumes/build/rustup")) {
  env.RUSTUP_HOME ||= path.resolve("volumes/build/rustup");
  env.CARGO_HOME ||= path.resolve("volumes/build/cargo");
}
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "native/smb/Cargo.toml",
  ],
  { stdio: "inherit", env },
);
if (result.status !== 0) process.exit(result.status || 1);
const library =
  process.platform === "darwin"
    ? "libtransfarr_smb.dylib"
    : process.platform === "win32"
      ? "transfarr_smb.dll"
      : "libtransfarr_smb.so";
copyFileSync(
  `native/smb/target/release/${library}`,
  "native/smb/transfarr-smb.node",
);
