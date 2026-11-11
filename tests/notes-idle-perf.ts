import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `idle-${Date.now()}`);
mkdirSync(output, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId, makeTextPdf } = await import("../sumatrapdf/tests/util.ts");
const { setProcessDpiAware } = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const input = process.argv[2];
const pdf = input || join(output, "idle.pdf");
if (!input) writeFileSync(pdf, makeTextPdf("Idle performance test document."));
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = true\nUseTabs = true\nShowStartPage = true\n",
);
function cpuTime(pid: number): number {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CPU`],
    { encoding: "utf8" },
  );
  return Number(result.stdout.trim());
}
let app: any;
const results: any[] = [];
async function idle(name: string) {
  await app.client.layout("start");
  const before = cpuTime(app.proc.pid);
  await Bun.sleep(3000);
  const cpu = cpuTime(app.proc.pid) - before;
  const layout = await app.client.layout();
  const pingStart = performance.now();
  await app.client.request(1);
  const row = {
    name,
    cpuSeconds: cpu,
    layoutCount: layout.count,
    pingMs: performance.now() - pingStart,
  };
  results.push(row);
  console.log(row);
  await app.client.layout("stop");
}
try {
  const started = performance.now();
  app = await launchControlled([
    "-appdata",
    data,
    "-log-to-file",
    join(output, "sumlog.txt"),
    pdf,
  ]);
  await app.client.waitForRenderIdle();
  console.log({
    bytes: statSync(pdf).size,
    openMs: performance.now() - started,
  });
  await idle("document");
  sendCommandSync(app.frame, cmdId("CmdNewTab"));
  await app.client.waitForHomePainted();
  await Bun.sleep(1000);
  await idle("history");
  console.log(`Artifacts: ${output}`);
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
  for (const row of results)
    assert.ok(
      row.cpuSeconds < 0.8,
      `${row.name} must settle while idle: ${row.cpuSeconds}s CPU`,
    );
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
