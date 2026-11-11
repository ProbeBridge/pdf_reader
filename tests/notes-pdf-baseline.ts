import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `pdf-baseline-${Date.now()}`);
mkdirSync(output, { recursive: true });
const pdf = process.argv[2];
if (!pdf)
  throw new Error("Pass the PDF path to compare; it is opened read-only.");
const {
  waitForTopWindow,
  moveWindow,
  setProcessDpiAware,
  postMessage,
  WM_CLOSE,
  killAndWait,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
function sample(pid: number) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Id ${pid}; Write-Output ($p.CPU.ToString([Globalization.CultureInfo]::InvariantCulture) + ',' + $p.WorkingSet64)`,
    ],
    { encoding: "utf8" },
  );
  const [cpu, bytes] = result.stdout.trim().split(",").map(Number);
  return { cpu, bytes };
}
const results = [];
for (const [name, exe] of [
  ["official-3.5.2", "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe"],
  ["custom", join(root, "sumatrapdf", "out", "rel64", "SumatraPDF.exe")],
]) {
  const data = join(output, name);
  mkdirSync(data);
  writeFileSync(
    join(data, "SumatraPDF-settings.txt"),
    "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = false\nUseTabs = true\nDefaultZoom = fit page\nWindowPos = 100 80 1280 900\n",
  );
  const started = performance.now();
  const log = join(output, `${name}-sumlog.txt`);
  const extra = name === "custom" ? ["-log-to-file", log] : [];
  const proc = Bun.spawn(
    [exe, "-appdata", data, "-new-window", ...extra, pdf],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    const frame = await waitForTopWindow(proc.pid, "SUMATRA_PDF_FRAME");
    if (!frame) throw new Error(`${name}: frame did not open`);
    moveWindow(frame, 100, 80, 1280, 900);
    const frameMs = performance.now() - started;
    let previous = sample(proc.pid);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(2000);
      const current = sample(proc.pid);
      samples.push({
        cpuSeconds: current.cpu - previous.cpu,
        workingSetBytes: current.bytes,
      });
      previous = current;
    }
    const row = { name, frameMs, samples, uiaRequests: [] as string[] };
    results.push(row);
    console.log(row);
    postMessage(frame, WM_CLOSE, 0, 0);
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    if (existsSync(log)) {
      row.uiaRequests = readFileSync(log, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("UIA GetText:"));
      console.log("UIA request limits", row.uiaRequests);
    }
  } finally {
    if (proc.exitCode === null) await killAndWait(proc);
  }
}
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
console.log(`Artifacts: ${output}`);
