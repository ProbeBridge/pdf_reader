import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "darwin")
  throw new Error("This command installs the macOS app on a Mac.");
const source = resolve(
  root,
  "sumatrapdf/out/mac/rel/.bundle.noindex/SumatraPDF AI.app",
);
if (!existsSync(source)) throw new Error("Run npm run build:mac first.");
const apps = resolve(homedir(), "Applications");
const target = resolve(apps, "SumatraPDF AI.app");
const stage = `${target}.install-${process.pid}`;
const backup = `${target}.previous-${process.pid}`;
const running = spawnSync("pgrep", [
  "-f",
  `${target}/Contents/MacOS/SumatraPDF`,
]);
if (running.status === 0)
  throw new Error("Quit SumatraPDF AI before installing an update.");
mkdirSync(apps, { recursive: true });
try {
  cpSync(source, stage, { recursive: true });
  const verify = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", stage],
    { stdio: "inherit" },
  );
  if (verify.status !== 0)
    throw new Error("App signature verification failed.");
  if (existsSync(target)) renameSync(target, backup);
  try {
    renameSync(stage, target);
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`Installed ${target}`);
if (process.argv.includes("--launch"))
  spawnSync("open", [target], { stdio: "inherit" });
