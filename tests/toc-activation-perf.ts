import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `toc-activation-${Date.now()}`),
  data = join(output, "appdata"),
  count = 6000;
mkdirSync(data, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf/out/rel64/SumatraPDF.exe",
);
const { launchControlled, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { assemblePdf } = await import("../sumatrapdf/tests/util.ts");
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const {
  findChildWindow,
  getParentWindow,
  sendMessage,
  packCoords,
  getClientRect,
  captureWindowDCRegionPixels,
  captureWindowToPng,
  treeGetRoot,
  sendText,
  setProcessDpiAware,
  TVM_GETCOUNT,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  MK_LBUTTON,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const pdfArg = process.argv.indexOf("--pdf"),
  pdf =
    pdfArg >= 0
      ? resolve(process.argv[pdfArg + 1])
      : join(output, "large-outline.pdf"),
  wrap = process.argv.includes("--wrap"),
  restore = process.argv.includes("--restore");
if (pdfArg < 0) {
  writeFileSync(
    pdf,
    Buffer.from(
      assemblePdf([
        "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        `<< /Type /Outlines /First 5 0 R /Last ${count + 4} 0 R /Count ${count} >>`,
        ...Array.from(
          { length: count },
          (_, i) =>
            `<< /Title (Bookmark ${i + 1}: technical section title for directory activation) /Parent 4 0 R ${i ? `/Prev ${i + 4} 0 R` : ""} ${i + 1 < count ? `/Next ${i + 6} 0 R` : ""} /Dest [3 0 R /Fit] >>`,
        ),
      ]),
      "latin1",
    ),
  );
}
const profile = process.argv.includes("--profile")
  ? readFileSync(
      join(process.env.LOCALAPPDATA!, "SumatraPDF-AI/SumatraPDF-settings.txt"),
      "utf8",
    )
      .replace(/^RestoreSession\s*=.*$/m, `RestoreSession = ${restore}`)
      .replace(/^RememberOpenedFiles\s*=.*$/m, "RememberOpenedFiles = false")
  : "";
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  profile ||
    `RestoreSession = ${restore}\nCheckForUpdates = false\nShowToc = true\nShowFavorites = false\nRememberOpenedFiles = ${restore}\nReuseInstance = false\nSidebarDx = 400\nTreeFontSize = 20\nTheme = Light\nTocWrapText = ${wrap}\n` +
      (restore
        ? `SessionData [\n [\n TabStates [\n [\n FilePath = ${pdf}\n ShowToc = true\n PageNo = 1\n ]\n ]\n TabIndex = 1\n WindowState = 1\n WindowPos = 80 50 1400 950\n ]\n]\n`
        : ""),
);
let app: any;
const report: any = { output, pdf, wrap, restore, switches: [] };
try {
  const started = performance.now();
  app = await launchControlled(
    [
      "-appdata",
      data,
      "-log-to-file",
      join(output, "native.log"),
      "-window-pos",
      "1400x950@80x50",
      ...(restore ? [] : [pdf]),
    ],
    { saveSettings: restore },
  );
  if (restore) await app.client.waitForSessionRestored(30000);
  await app.client.waitForRenderIdle();
  const tree = findChildWindow(app.frame, "SysTreeView32"),
    panel = getParentWindow(tree);
  assert.ok(tree && panel);
  async function state() {
    const rows = await app.client.request(ControlCommand.TestTocRows);
    assert.equal(rows[0], 0, String(rows[1]));
    return {
      rebuilds: Number(/rebuilds=(\d+)/.exec(String(rows[1]))?.[1]),
      items: Number(sendMessage(tree, TVM_GETCOUNT, 0, 0)),
      root: String(treeGetRoot(tree)),
      raw: String(rows[1]).split("\n")[0],
    };
  }
  function checkPaint(name: string) {
    sendMessage(tree, 0x000f, 0, 0);
    const rect = getClientRect(tree),
      h = Math.min(250, rect.bottom),
      w = rect.right,
      pixels = captureWindowDCRegionPixels(tree, 0, 0, w, h);
    assert.ok(pixels && w > 100 && h > 100);
    let ink = 0;
    for (let y = 3; y < h - 3; y++)
      for (let x = 40; x < w - 30; x++) {
        const i = (y * w + x) * 4;
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 180) ink++;
      }
    captureWindowToPng(tree, join(output, `${name}.png`));
    return ink;
  }
  async function selectView(index: number) {
    const buttons = (await app.client.virtTree())
      .filter((c: any) => c.hwnd === panel && c.kind === "virtCtrlIconButton")
      .sort((a: any, b: any) => a.rect.x - b.rect.x);
    assert.ok(buttons.length >= 3);
    const b = buttons[index].rect,
      lp = packCoords(b.x + Math.floor(b.dx / 2), b.y + Math.floor(b.dy / 2));
    const start = performance.now();
    sendMessage(panel, WM_LBUTTONDOWN, MK_LBUTTON, lp);
    sendMessage(panel, WM_LBUTTONUP, 0, lp);
    await app.client.request(ControlCommand.Ping);
    return performance.now() - start;
  }
  report.startupMs = performance.now() - started;
  report.initial = await state();
  const documentBefore = await app.client.request(
    ControlCommand.TestScrollState,
  );
  report.initial.ink = checkPaint("initial");
  for (let i = 0; i < 4; i++) {
    await selectView(1);
    const activationMs = await selectView(0);
    await app.client.waitForRenderIdle();
    const current = await state();
    const ink = checkPaint(`switch-${i}`);
    report.switches.push({ activationMs, ink, ...current });
  }
  assert.deepEqual(
    await app.client.request(ControlCommand.TestScrollState),
    documentBefore,
    "directory activation must preserve the document position",
  );
  if (wrap) {
    const deadline = Date.now() + 30000;
    let rows = "",
      maxPingMs = 0;
    do {
      const start = performance.now();
      rows = String((await app.client.request(ControlCommand.TestTocRows))[1]);
      maxPingMs = Math.max(maxPingMs, performance.now() - start);
      if (!/fontPending=1/.test(rows)) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    report.background = { maxPingMs, header: rows.split("\n")[0] };
    assert.ok(
      !/fontPending=1/.test(rows),
      "initial wrapped row measurements must finish",
    );
    assert.ok(
      maxPingMs < 120,
      `initial wrapped layout must keep accepting input: ${maxPingMs}ms`,
    );
    assert.equal(
      Number(/fontMeasured=(\d+)/.exec(rows)?.[1]),
      report.initial.items,
    );
  }
  // Reattaching the sidebar must also keep the active search model.
  if (pdfArg < 0) {
    sendText(findChildWindow(panel, "Edit"), "Bookmark 6000");
    const deadline = Date.now() + 5000;
    while (
      Number(sendMessage(tree, TVM_GETCOUNT, 0, 0)) !== 1 &&
      Date.now() < deadline
    )
      await Bun.sleep(25);
    report.filteredBefore = await state();
    await selectView(1);
    await selectView(0);
    report.filteredAfter = await state();
  }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(
    report.initial.rebuilds,
    1,
    "startup must populate the directory only once",
  );
  if (pdfArg < 0)
    assert.ok(
      report.startupMs < 2500,
      `directory startup must finish promptly: ${report.startupMs}ms`,
    );
  assert.ok(report.initial.ink > 100, "directory text must paint on startup");
  for (const current of report.switches) {
    assert.equal(
      current.rebuilds,
      report.initial.rebuilds,
      "returning to bookmarks must reuse the directory",
    );
    assert.equal(
      current.root,
      report.initial.root,
      "bookmark handles must survive sidebar activation",
    );
    assert.equal(current.items, report.initial.items);
    assert.ok(
      current.ink > 100,
      "directory text must paint after switching back",
    );
    assert.ok(
      current.activationMs < 120,
      `directory activation must not scan every row: ${current.activationMs}ms`,
    );
  }
  if (pdfArg < 0) {
    assert.equal(report.filteredBefore.items, 1);
    for (const field of ["items", "root", "rebuilds"])
      assert.equal(
        report.filteredAfter[field],
        report.filteredBefore[field],
        "sidebar activation must preserve search results",
      );
  }
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
