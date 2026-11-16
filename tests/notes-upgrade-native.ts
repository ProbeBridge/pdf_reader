import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `notes-upgrade-${Date.now()}`),
  data = join(output, "appdata");
mkdirSync(data, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf/out/rel64/SumatraPDF.exe",
);
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { makeTextPdf, cmdId } = await import("../sumatrapdf/tests/util.ts");
const file = join(output, "upgrade.pdf"),
  count = 1012;
writeFileSync(
  file,
  makeTextPdf(
    "Verify a local upgrade without using production settings or credentials.",
  ),
);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nReuseInstance = false\nRememberOpenedFiles = true\nRememberStatePerDocument = true\nFileStates [\n" +
    Array.from(
      { length: count },
      (_, i) =>
        `  [\n    FilePath = ${i ? `C:\\SumatraUpgradeFixture\\book${i}.pdf` : file}\n    OpenCount = 1\n    PageNo = 1\n  ]\n`,
    ).join("") +
    "]\n",
);
const seed = {
  settings: JSON.stringify({
    apiKey: "LOCAL_UPGRADE_TEST_ONLY",
    panelZoom: 130,
  }),
  "page:upgrade": JSON.stringify({
    annotations: [{ id: "legacy", quote: "portable 中文", status: "done" }],
  }),
  "library:upgrade": JSON.stringify({
    name: "upgrade.pdf",
    path: file,
    addedAt: 123,
  }),
};
const plainPath = join(output, "legacy-plain.json"),
  storePath = join(data, "context-notes.dat"),
  protectPath = join(output, "protect.ps1");
writeFileSync(plainPath, JSON.stringify(seed));
writeFileSync(
  protectPath,
  `param([string]$PlainPath,[string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$bytes=[Security.Cryptography.ProtectedData]::Protect([IO.File]::ReadAllBytes($PlainPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($OutputPath,$bytes)
`,
);
const protect = Bun.spawn(
  [
    "powershell.exe",
    "-NoProfile",
    "-File",
    protectPath,
    "-PlainPath",
    plainPath,
    "-OutputPath",
    storePath,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
assert.equal(await protect.exited, 0);
const original = readFileSync(storePath);
const reserve = createServer();
await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
const port = (reserve.address() as any).port;
await new Promise<void>((done) => reserve.close(() => done()));
let app: any, browser: any;
async function poll(read: () => Promise<any>) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const result = await read();
      if (result) return result;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Upgrade test did not reach its native bridge");
}
try {
  app = await launchControlled(["-appdata", data, file], {
    saveSettings: true,
    env: {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  browser = await poll(() =>
    chromium.connectOverCDP(`http://127.0.0.1:${port}`),
  );
  const notes = await poll(async () =>
    browser
      .contexts()
      .flatMap((context: any) => context.pages())
      .find((page: any) => page.url().endsWith("/index.html")),
  );
  const restored = await notes.evaluate(() =>
    (window as any).__sumatra__.call(
      "notes",
      JSON.stringify({ action: "read" }),
    ),
  );
  for (const [key, value] of Object.entries(seed))
    assert.deepEqual(restored[key], JSON.parse(value));
  const migrated = JSON.parse(readFileSync(storePath, "utf8"));
  for (const [key, value] of Object.entries(seed))
    assert.equal(migrated[key], value);
  assert.deepEqual(readFileSync(storePath + ".encrypted.bak"), original);
  console.log(
    "PASS: real Windows DPAPI migration preserves API settings, Unicode notes, library entries and exact original backup.",
  );
  await app.client.quit();
  app.client.close();
  await Promise.race([app.proc.exited, Bun.sleep(8000)]);
  if (app.proc.exitCode === null) await killAndWait(app.proc);
  assert.equal(app.proc.exitCode, 0);
  app = null;
  const settings = readFileSync(join(data, "SumatraPDF-settings.txt"), "utf8"),
    section = /^FileStates\s*\[\r?\n([\s\S]*?)^\]/m.exec(settings)?.[1] || "";
  assert.equal(
    (section.match(/\bFilePath\s*=/g) || []).length,
    count,
    "merging the native and AI profiles must not discard history beyond 1000 entries",
  );
  console.log(
    `PASS: all ${count} merged history entries survive document opening and shutdown. Artifacts: ${output}`,
  );
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
  if (browser) await browser.close().catch(() => {});
}
