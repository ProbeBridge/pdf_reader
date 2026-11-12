import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
} from "node:fs";
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
const apps = "/Applications";
const target = resolve(apps, "SumatraPDF AI.app");
const userTarget = resolve(homedir(), "Applications", "SumatraPDF AI.app");
// Preserve the .app suffix while staging so Spotlight recognizes the package.
const stageDir = resolve(apps, `.sumatra-install-${process.pid}.noindex`);
const stage = resolve(stageDir, "SumatraPDF AI.app");
const backup = resolve(stageDir, "previous.app");
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
for (const installed of [target, userTarget]) {
  const running = spawnSync("pgrep", [
    "-f",
    `${installed}/Contents/MacOS/SumatraPDF`,
  ]);
  if (running.status === 0)
    throw new Error("Quit SumatraPDF AI before installing an update.");
}
mkdirSync(apps, { recursive: true });
mkdirSync(stageDir, { recursive: true });
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
  // Migrate the old per-user app only after the shared installation succeeds.
  if (existsSync(userTarget)) {
    spawnSync(lsregister, ["-u", userTarget], { stdio: "ignore" });
    rmSync(userTarget, { recursive: true, force: true });
  }
  // Refresh metadata after moving out of the excluded staging directory.
  const installedAt = new Date();
  utimesSync(target, installedAt, installedAt);
  spawnSync(lsregister, ["-f", target], { stdio: "ignore" });
  spawnSync("mdimport", ["-i", target], { stdio: "ignore" });
} finally {
  if (!existsSync(backup)) rmSync(stageDir, { recursive: true, force: true });
}
console.log(`Installed ${target}`);
if (process.argv.includes("--launch"))
  spawnSync("open", [target], { stdio: "inherit" });
