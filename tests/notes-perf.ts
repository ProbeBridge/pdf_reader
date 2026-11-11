import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `notes-perf-${Date.now()}`);
mkdirSync(output, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const { launchControlled, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const { makeTopBottomPdf } = await import("../sumatrapdf/tests/util.ts");
const pdf = join(output, "sixteen-pages.pdf");
writeFileSync(pdf, makeTopBottomPdf(16));
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = false\nUseTabs = true\nDefaultZoom = fit page\n",
);
let app: any;
try {
  app = await launchControlled([
    "-appdata",
    data,
    "-log-to-file",
    join(output, "sumlog.txt"),
    pdf,
  ]);
  await app.client.waitForRenderIdle();
  const results: Record<string, Record<string, number>> = {};
  for (const [name, action, limit] of [
    ["hover", "hover", 0],
    ["zero", "uia", 0],
    ["preview", "uia", 4],
    ["full", "uia", -1],
  ] as const) {
    const result = await app.client.request(ControlCommand.TestNotesPerf, [
      action,
      limit,
    ]);
    assert.equal(result[0], 0, String(result[1]));
    const raw = String(result[1]);
    const values = Object.fromEntries(
      [...raw.matchAll(/([A-Za-z]+)=(-?\d+)/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    results[name] = values;
    console.log(name, values);
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Artifacts: ${output}`);
  assert.equal(
    results.hover.cachedAfter,
    0,
    "a page with no notes must not extract text on hover",
  );
  assert.equal(
    results.zero.cachedAfter,
    results.zero.cachedBefore,
    "UIA GetText(0) must not extract any pages",
  );
  assert.equal(results.zero.length, 0);
  assert.equal(results.preview.length, 4);
  assert.ok(
    results.preview.cachedAfter <= results.preview.cachedBefore + 1,
    "a four-character preview must not scan all 16 pages",
  );
  assert.equal(results.preview.visibleOffscreen, 0);
  assert.equal(
    results.preview.hiddenOffscreen,
    1,
    "an offscreen page must identify itself as offscreen",
  );
  assert.equal(
    results.preview.hiddenValue,
    0,
    "an uncached offscreen page must not advertise a value",
  );
  assert.equal(
    results.preview.hiddenRect,
    0,
    "offscreen pages must not return onscreen bounds",
  );
  assert.equal(
    results.full.cachedAfter,
    16,
    "unlimited UIA text must retain access to the full document",
  );
  assert.ok(results.full.length > 100);
  console.log(
    "PASS: empty-note hover does no work; UIA previews are bounded; offscreen values are virtualized; full text remains available.",
  );
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
