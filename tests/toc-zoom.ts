import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `toc-zoom-${Date.now()}`);
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
const { assemblePdf } = await import("../sumatrapdf/tests/util.ts");
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const {
  findChildWindow,
  treeGetRoot,
  treeGetNextItem,
  treeGetSelection,
  treeGetItemHeight,
  treeExpand,
  countVisibleTreeRows,
  sendMessage,
  clientToScreen,
  packCoords,
  setProcessDpiAware,
  TVGN_CHILD,
  TVGN_CARET,
  TVE_EXPAND,
  TVM_SELECTITEM,
  MK_CONTROL,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const longTitle =
  "A long bold italic bookmark heading that wraps over multiple lines and must retain its complete title while the text becomes larger";
const pdf = join(output, "toc-zoom.pdf");
writeFileSync(
  pdf,
  Buffer.from(
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 5 0 R /Last 7 0 R /Count 3 >>",
      `<< /Title (${longTitle}) /Parent 4 0 R /Next 7 0 R /First 6 0 R /Last 6 0 R /Count 1 /F 3 /Dest [3 0 R /Fit] >>`,
      "<< /Title (Nested italic bookmark) /Parent 5 0 R /F 1 /Dest [3 0 R /Fit] >>",
      "<< /Title (Bold second heading) /Parent 4 0 R /Prev 5 0 R /F 2 /Dest [8 0 R /Fit] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
    "latin1",
  ),
);
const data = join(output, "appdata");
mkdirSync(data);
const preferencesPath = join(data, "SumatraPDF-settings.txt");
writeFileSync(
  preferencesPath,
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = true\nRememberOpenedFiles = true\nUseTabs = true\nSidebarDx = 260\nDefaultZoom = 125\nTreeFontSize = 12\nUIFontSize = 16\nTocWrapText = true\n",
);
let app: any;
let tree = 0;
async function start() {
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", pdf],
    { saveSettings: true },
  );
  await app.client.waitForRenderIdle();
  tree = findChildWindow(app.frame, "SysTreeView32");
  assert.ok(tree, "TOC tree exists");
}
async function stop() {
  if (!app) return;
  await app.client.quit().catch(() => {});
  app.client.close();
  await Promise.race([app.proc.exited, Bun.sleep(8000)]);
  if (app.proc.exitCode === null) await killAndWait(app.proc);
  app = null;
}
async function rows() {
  const result = await app.client.request(ControlCommand.TestTocRows);
  assert.equal(result[0], 0, String(result[1]));
  const raw = String(result[1]);
  const height = Number(/rowDy=(\d+)/.exec(raw)?.[1]);
  const long = Number(
    new RegExp(`row y=-?\\d+ dy=(\\d+) title=${longTitle}`).exec(raw)?.[1],
  );
  return { height, long, raw };
}
function wheel(delta: number, control = true) {
  const point = clientToScreen(tree, 40, 40);
  sendMessage(
    tree,
    0x020a,
    ((delta & 0xffff) << 16) | (control ? MK_CONTROL : 0),
    packCoords(point.x, point.y),
  );
}
async function documentState() {
  const scroll = await app.client.request(ControlCommand.TestScrollState);
  const mode = await app.client.request(ControlCommand.TestDisplayMode, [
    "get",
  ]);
  const layout = await app.client.layout();
  return { scroll: scroll[1], mode: mode[1], canvas: layout.items.canvas.rect };
}
try {
  await start();
  const rootItem = treeGetRoot(tree);
  treeExpand(tree, TVE_EXPAND, rootItem);
  assert.notEqual(
    treeGetNextItem(tree, TVGN_CHILD, rootItem),
    0n,
    "nested outline is populated",
  );
  sendMessage(tree, TVM_SELECTITEM, TVGN_CARET, rootItem);
  const selected = treeGetSelection(tree);
  const count = countVisibleTreeRows(tree);
  const expanded = Number(sendMessage(tree, 0x1127, rootItem, 0x20)); // TVM_GETITEMSTATE / TVIS_EXPANDED
  const beforeState = await documentState();
  const before = await rows();
  console.log("before", before);
  assert.equal(before.height, treeGetItemHeight(tree));
  assert.ok(before.long >= before.height * 2, "long styled bookmark wraps");
  wheel(120);
  const bigger = await rows();
  console.log("bigger", bigger);
  assert.ok(
    bigger.height > before.height,
    "Ctrl+wheel must enlarge the TOC font and row height",
  );
  assert.ok(
    bigger.long > before.long,
    "bold italic wrapped rows must be remeasured",
  );
  assert.equal(
    treeGetSelection(tree),
    selected,
    "a font change must preserve selection handles without rebuilding the tree",
  );
  wheel(-120);
  const restored = await rows();
  console.log("restored", restored);
  assert.equal(
    restored.height,
    before.height,
    "negative Ctrl+wheel restores the size",
  );
  assert.equal(
    restored.long,
    before.long,
    "restoring the font also restores styled wrapped row measurements",
  );
  for (let i = 0; i < 3; i++) wheel(30);
  assert.equal(
    (await rows()).height,
    before.height,
    "partial wheel deltas must accumulate",
  );
  wheel(30);
  assert.equal(
    (await rows()).height,
    bigger.height,
    "four high-resolution wheel events form one notch",
  );
  wheel(120, false);
  assert.equal(
    (await rows()).height,
    bigger.height,
    "normal scrolling must not zoom the TOC",
  );
  wheel(-120);
  for (let i = 0; i < 20; i++) wheel(-120);
  const minimum = treeGetItemHeight(tree);
  wheel(-120);
  assert.equal(
    treeGetItemHeight(tree),
    minimum,
    "font size clamps at the minimum",
  );
  for (let i = 0; i < 40; i++) wheel(120);
  const maximum = treeGetItemHeight(tree);
  wheel(120);
  assert.equal(
    treeGetItemHeight(tree),
    maximum,
    "font size clamps at the maximum",
  );
  for (let i = 0; i < 25; i++) wheel(-120); // 64 -> 14
  assert.equal(treeGetItemHeight(tree), bigger.height);
  assert.equal(
    treeGetSelection(tree),
    selected,
    "font updates must preserve selection handles",
  );
  assert.equal(
    countVisibleTreeRows(tree),
    count,
    "font updates must preserve expansion state",
  );
  assert.equal(Number(sendMessage(tree, 0x1127, rootItem, 0x20)), expanded);
  assert.deepEqual(
    await documentState(),
    beforeState,
    "TOC zoom must not navigate, zoom or resize the document",
  );
  await stop();
  const preferences = readFileSync(preferencesPath, "utf8");
  assert.match(preferences, /^TreeFontSize\s*=\s*14\s*$/m);
  await start();
  assert.equal(
    treeGetItemHeight(tree),
    bigger.height,
    "the selected TOC font size persists after restart",
  );
  await stop();
  writeFileSync(
    preferencesPath,
    readFileSync(preferencesPath, "utf8").replace(
      /^TreeFontSize\s*=.*$/m,
      "TreeFontSize = 0",
    ),
  );
  await start();
  const controls = await app.client.virtTree();
  assert.ok(
    controls.some((item: any) => item.text === "100%"),
    "zero uses the default font and 100% label",
  );
  console.log(
    "PASS: TOC Ctrl+wheel, precision wheel, styled wrapping, bounds, selection, expansion, unchanged document and persistence.",
  );
  console.log(`Artifacts: ${output}`);
} finally {
  await stop();
}
