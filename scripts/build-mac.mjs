import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "darwin")
  throw new Error("This command builds the macOS app on a Mac.");
const args = process.argv.slice(2);
const mode = args.includes("--debug") ? "-dbg" : "-rel";
const result = spawnSync(
  resolve(root, "node_modules/.bin/bun"),
  ["cmd/ng-build.ts", mode, ...(args.includes("--clean") ? ["-clean"] : [])],
  { cwd: resolve(root, "sumatrapdf"), stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
