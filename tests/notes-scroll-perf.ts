import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `scroll-${Date.now()}`);
mkdirSync(output, { recursive: true });
const pdf = process.argv[2];
if (!pdf) throw new Error("Pass a PDF path; the file is opened read-only.");
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const { launchControlled, sendCommandSync, findCanvas, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId } = await import("../sumatrapdf/tests/util.ts");
const { postMessage, packCoords, clientToScreen, setProcessDpiAware } =
  await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = false\nUseTabs = true\nDefaultZoom = fit page\n",
);
const log = join(output, "sumlog.txt");
function cpuTime(pid: number) {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CPU`],
    { encoding: "utf8" },
  );
  return Number(result.stdout.trim());
}
let app: any;
try {
  app = await launchControlled(["-appdata", data, "-log-to-file", log, pdf]);
  await app.client.waitForRenderIdle();
  const results = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    sendCommandSync(app.frame, cmdId("CmdGoToNextPage"));
    const commandMs = performance.now() - start;
    await app.client.waitForRenderIdle();
    results.push({
      phase: "nextPage",
      commandMs,
      renderMs: performance.now() - start,
    });
  }
  const canvas = findCanvas(app.frame);
  const point = clientToScreen(canvas, 200, 200);
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    postMessage(
      canvas,
      0x020a,
      (-360 & 0xffff) << 16,
      packCoords(point.x, point.y),
    );
    await Bun.sleep(80);
    await app.client.waitForRenderIdle();
    results.push({ phase: "wheel", renderMs: performance.now() - start });
  }
  const before = cpuTime(app.proc.pid);
  await Bun.sleep(3000);
  const idleCpu = cpuTime(app.proc.pid) - before;
  console.log({ results, idleCpu });
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify({ results, idleCpu }, null, 2),
  );
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
const requests = readFileSync(log, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("UIA GetText:"));
console.log("UIA request limits", requests);
console.log(`Artifacts: ${output}`);
