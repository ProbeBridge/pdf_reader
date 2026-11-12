import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `toc-zoom-perf-${Date.now()}`),
  data = join(output, "appdata");
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
  sendMessage,
  clientToScreen,
  packCoords,
  setProcessDpiAware,
  treeExpandRecursively,
  treeGetSelection,
  treeGetItemHeight,
  repaintWindow: forceRepaint,
  TVE_EXPAND,
  TVM_GETCOUNT,
  MK_CONTROL,
  getScrollInfo,
  SB_HORZ,
  getParentWindow,
  sendText,
  getForegroundWindow,
  setForegroundWindow,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const previousForeground = getForegroundWindow();
const pdfArg = process.argv.indexOf("--pdf"),
  wrap = process.argv.includes("--wrap"),
  sampleCount = Number(
    process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] ||
      10,
  ),
  count = 6000;
assert.ok(
  Number.isInteger(sampleCount) && sampleCount >= 2 && sampleCount % 2 === 0,
);
let pdf =
  pdfArg >= 0
    ? resolve(process.argv[pdfArg + 1])
    : join(output, "large-outline.pdf");
if (pdfArg < 0) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Type /Outlines /First 5 0 R /Last ${count + 4} 0 R /Count ${count} >>`,
    ...Array.from(
      { length: count },
      (_, i) =>
        `<< /Title (Bookmark ${i + 1}: a long technical section title for measuring directory font scaling) /Parent 4 0 R ${i ? `/Prev ${i + 4} 0 R` : ""} ${i + 1 < count ? `/Next ${i + 6} 0 R` : ""} /Dest [3 0 R /Fit] >>`,
    ),
  ];
  writeFileSync(pdf, Buffer.from(assemblePdf(objects), "latin1"));
}
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  `RestoreSession = false\nCheckForUpdates = false\nShowToc = true\nRememberOpenedFiles = false\nUseTabs = true\nSidebarDx = 400\nDefaultZoom = fit page\nTreeFontSize = 20\nTocWrapText = ${wrap}\n`,
);
let app: any;
const report: any = { pdf, wrap, output };
try {
  app = await launchControlled([
    "-appdata",
    data,
    "-log-to-file",
    join(output, "native.log"),
    "-window-pos",
    "1400x950@80x50",
    pdf,
  ]);
  await app.client.waitForRenderIdle();
  // Keep the user's app active; other apps' input must not starve this reader's idle work.
  if (previousForeground && previousForeground !== app.frame)
    setForegroundWindow(previousForeground);
  const tree = findChildWindow(app.frame, "SysTreeView32");
  assert.ok(tree);
  treeExpandRecursively(tree, TVE_EXPAND);
  const items = Number(sendMessage(tree, TVM_GETCOUNT, 0, 0));
  assert.ok(
    items >= (pdfArg < 0 ? count : 1000),
    "exercise a genuinely large native TOC",
  );
  const selection = treeGetSelection(tree),
    rowHeight = treeGetItemHeight(tree),
    before = await app.client.request(ControlCommand.TestScrollState),
    point = clientToScreen(tree, 80, 80),
    samples = [];
  forceRepaint(tree);
  async function dimensions() {
    const rows = await app.client.request(ControlCommand.TestTocRows);
    assert.equal(rows[0], 0);
    return {
      labelDx: Number(/labelDx=(\d+)/.exec(String(rows[1]))?.[1]),
      pending: /fontPending=1/.test(String(rows[1])),
      maxSliceMs: Number(/fontSliceMs=([\d.]+)/.exec(String(rows[1]))?.[1]),
      commitMs: Number(/fontCommitMs=([\d.]+)/.exec(String(rows[1]))?.[1]),
      idleMs: Number(/fontIdleMs=(\d+)/.exec(String(rows[1]))?.[1]),
      measured: Number(/fontMeasured=(\d+)/.exec(String(rows[1]))?.[1]),
      workPending: /fontWorkPending=1/.test(String(rows[1])),
      horizontal: getScrollInfo(tree, SB_HORZ),
    };
  }
  async function settledDimensions() {
    const deadline = Date.now() + 30000;
    let state = await dimensions();
    while (state.pending && Date.now() < deadline) {
      await Bun.sleep(50);
      state = await dimensions();
    }
    assert.equal(
      state.pending,
      false,
      `background font measurements must finish: ${JSON.stringify(state)}`,
    );
    assert.ok(
      state.maxSliceMs < 80,
      `background font work must yield promptly: ${state.maxSliceMs}ms`,
    );
    assert.ok(
      state.idleMs >= 2500,
      "the full native font scan must wait for idle input",
    );
    return state;
  }
  const originalDimensions = await dimensions();
  const sizes = [originalDimensions];
  for (let i = 0; i < sampleCount; i++) {
    const start = performance.now(),
      delta = i % 2 ? -120 : 120;
    sendMessage(
      tree,
      0x020a,
      ((delta & 0xffff) << 16) | MK_CONTROL,
      packCoords(point.x, point.y),
    );
    const inputMs = performance.now() - start;
    forceRepaint(tree);
    samples.push({ inputMs, paintMs: performance.now() - start });
    if (i < 2) sizes.push(await settledDimensions());
  }
  console.log(JSON.stringify({ sizes }));
  assert.ok(
    sizes[1].labelDx > sizes[0].labelDx,
    "native label bounds must grow with the font",
  );
  assert.equal(
    sizes[2].labelDx,
    sizes[0].labelDx,
    "native label bounds must shrink with the font",
  );
  if (wrap) {
    assert.equal(
      sizes[1].measured,
      items,
      "remeasure every inserted wrapped row",
    );
    assert.equal(
      sizes[2].measured,
      items,
      "restore every inserted wrapped row",
    );
  }
  if (!wrap) {
    assert.ok(
      sizes[1].horizontal.max > sizes[0].horizontal.max,
      "long titles must remain horizontally reachable",
    );
    assert.deepEqual(
      sizes[2].horizontal,
      sizes[0].horizontal,
      "the horizontal range must shrink back",
    );
  }
  assert.equal(treeGetSelection(tree), selection);
  assert.equal(treeGetItemHeight(tree), rowHeight);
  assert.equal(Number(sendMessage(tree, TVM_GETCOUNT, 0, 0)), items);
  assert.deepEqual(
    await app.client.request(ControlCommand.TestScrollState),
    before,
    "directory zoom must preserve the document position",
  );
  const sorted = samples.map((s) => s.paintMs).sort((a, b) => a - b);
  Object.assign(report, {
    items,
    samples,
    sizes,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
  });
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.ok(
    report.medianMs < 80,
    `TOC zoom must repaint promptly: median ${report.medianMs.toFixed(1)}ms`,
  );
  if (pdfArg < 0) {
    // Rebuild the model while width updates are pending: no stale handles may survive.
    const filter = findChildWindow(getParentWindow(tree), "Edit");
    assert.ok(filter);
    sendMessage(
      tree,
      0x020a,
      (120 << 16) | MK_CONTROL,
      packCoords(point.x, point.y),
    );
    sendText(filter, "Bookmark 6000");
    async function waitForItems(expected: number) {
      const deadline = Date.now() + 10000;
      while (
        Number(sendMessage(tree, TVM_GETCOUNT, 0, 0)) !== expected &&
        Date.now() < deadline
      )
        await Bun.sleep(25);
      assert.equal(Number(sendMessage(tree, TVM_GETCOUNT, 0, 0)), expected);
      forceRepaint(tree);
      assert.equal((await dimensions()).pending, false);
    }
    await waitForItems(1);
    sendText(filter, "");
    await waitForItems(count);
  }
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
