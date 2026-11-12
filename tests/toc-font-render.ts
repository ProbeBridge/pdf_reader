import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `toc-font-render-${Date.now()}`),
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
  captureWindowDCRegionPixels,
  captureWindowToPng,
  sendMessage,
  clientToScreen,
  packCoords,
  getClientRect,
  setProcessDpiAware,
  MK_CONTROL,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const title =
    "6.2\tSection heading with a long title extending beyond the bookmark pane width",
  pdf = join(output, "outline-groups.pdf");
writeFileSync(
  pdf,
  Buffer.from(
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 4 >>",
      "<< /Title (Current chapter) /Parent 5 0 R /Next 8 0 R /First 7 0 R /Last 7 0 R /Count 1 >>",
      "<< /Title (Current page) /Parent 6 0 R /Dest [3 0 R /Fit] >>",
      `<< /Title (${title}) /Parent 5 0 R /Prev 6 0 R /First 9 0 R /Last 9 0 R /Count 1 /Dest [4 0 R /Fit] >>`,
      "<< /Title (Another page) /Parent 8 0 R /Dest [4 0 R /Fit] >>",
    ]),
    "latin1",
  ),
);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = true\nTheme = Light\nRememberOpenedFiles = false\nSidebarDx = 400\nTreeFontSize = 20\nTocWrapText = false\nShowTocPageNumbers = true\n",
);
let app: any;
try {
  app = await launchControlled([
    "-appdata",
    data,
    "-window-pos",
    "1400x950@80x50",
    pdf,
  ]);
  await app.client.waitForRenderIdle();
  const tree = findChildWindow(app.frame, "SysTreeView32");
  assert.ok(tree);
  async function check(name: string) {
    sendMessage(tree, 0x000f, 0, 0); // WM_PAINT: keep the app's erase policy.
    const result = await app.client.request(ControlCommand.TestTocRows);
    assert.equal(result[0], 0);
    const rows = String(result[1]),
      row = /row y=(-?\d+) dy=(\d+) title=6\.2 Section heading/.exec(rows);
    assert.ok(row, rows);
    const rect = getClientRect(tree),
      cap = {
        w: rect.right,
        h: rect.bottom,
        data: captureWindowDCRegionPixels(tree, 0, 0, rect.right, rect.bottom),
      };
    assert.ok(cap.data);
    captureWindowToPng(tree, join(output, `${name}.png`));
    const y0 = Number(row[1]) + 2,
      y1 = y0 + Number(row[2]) - 4;
    let light = 0,
      dark = 0,
      ink = 0,
      total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 70; x < cap.w - 12; x++) {
        const i = (y * cap.w + x) * 4,
          b = cap.data[i],
          g = cap.data[i + 1],
          r = cap.data[i + 2];
        if (Math.min(r, g, b) > 220) light++;
        if (Math.max(r, g, b) < 40) dark++;
        if (Math.max(r, g, b) < 180) ink++;
        total++;
      }
    }
    const stats = {
      name,
      light: light / total,
      dark: dark / total,
      ink: ink / total,
      rows,
    };
    console.log(JSON.stringify(stats));
    assert.ok(
      stats.light > 0.6 && stats.dark < 0.4,
      "bookmark rows must retain the light background",
    );
  }
  async function settle() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const rows = await app.client.request(ControlCommand.TestTocRows);
      if (!/fontPending=1/.test(String(rows[1]))) return;
      await Bun.sleep(50);
    }
    assert.fail("font updates must finish");
  }
  await check("initial");
  // Scroll different glyphs across the old background sampling point.
  for (let x = 24; x <= 80; x += 2) {
    sendMessage(tree, 0x0114, (x << 16) | 4, 0);
    await check(`scroll-${x}`);
  }
  sendMessage(tree, 0x0114, (300 << 16) | 4, 0); // WM_HSCROLL / SB_THUMBPOSITION
  await check("scrolled");
  const point = clientToScreen(tree, 80, 80);
  for (const delta of [120, -120]) {
    sendMessage(
      tree,
      0x020a,
      ((delta & 0xffff) << 16) | MK_CONTROL,
      packCoords(point.x, point.y),
    );
    await check(delta > 0 ? "larger" : "restored");
    await settle();
    await check(delta > 0 ? "larger-idle" : "restored-idle");
  }
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
