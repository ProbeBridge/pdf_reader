import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `notes-width-${Date.now()}`);
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
const { cmdId } = await import("../sumatrapdf/tests/util.ts");
const { makeTocPdf } = await import("../sumatrapdf/tests/issue-6167.ts");
const {
  setProcessDpiAware,
  sendMessage,
  setCursorPos,
  clientToScreen,
  packCoords,
  moveWindow,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
  MK_LBUTTON,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const pdf = join(output, "notes-width.pdf");
writeFileSync(pdf, makeTocPdf());
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = true\nRememberOpenedFiles = true\nUseTabs = true\nSidebarDx = 240\nDefaultZoom = 125\n",
);
let app: any;
let wanted = 0;
async function splitter() {
  return (await app.client.virtTree("SUMATRA_PDF_FRAME")).find(
    (item: any) => item.name === "contextNotesSplitter",
  );
}
async function notesWidth() {
  const layout = await app.client.layout();
  const slot = layout.nodes.find((node: any) => node.path === "frameLayout/6");
  assert.ok(slot, "notes slot exists");
  return slot.visible ? slot.rect.dx : 0;
}
async function stop() {
  if (!app) return;
  await app.client.quit().catch(() => {});
  app.client.close();
  await Promise.race([app.proc.exited, Bun.sleep(8000)]);
  if (app.proc.exitCode === null) await killAndWait(app.proc);
  app = null;
}
try {
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", pdf],
    { saveSettings: true },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  await Bun.sleep(800);
  const bar = await splitter();
  assert.ok(bar, "the notes panel must expose a native draggable splitter");
  const before = await notesWidth();
  const from = {
    x: bar.rect.x + Math.floor(bar.rect.dx / 2),
    y: bar.rect.y + Math.floor(bar.rect.dy / 2),
  };
  const to = { x: from.x - 140, y: from.y };
  let screen = clientToScreen(app.frame, from.x, from.y);
  setCursorPos(screen.x, screen.y);
  sendMessage(
    app.frame,
    WM_LBUTTONDOWN,
    MK_LBUTTON,
    packCoords(from.x, from.y),
  );
  screen = clientToScreen(app.frame, to.x, to.y);
  setCursorPos(screen.x, screen.y);
  sendMessage(app.frame, WM_MOUSEMOVE, MK_LBUTTON, packCoords(to.x, to.y));
  assert.equal(
    await notesWidth(),
    before,
    "drag preview must not repeatedly resize the WebView",
  );
  sendMessage(app.frame, WM_LBUTTONUP, 0, packCoords(to.x, to.y));
  await app.client.waitForRenderIdle();
  wanted = await notesWidth();
  assert.ok(
    wanted >= before + 130,
    `drag must widen notes: ${before} -> ${wanted}`,
  );
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  await Bun.sleep(100);
  assert.equal(
    await splitter(),
    undefined,
    "closing notes must hide the splitter",
  );
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  await app.client.waitForRenderIdle();
  assert.ok(
    Math.abs((await notesWidth()) - wanted) <= 2,
    "reopening must retain the width",
  );
  moveWindow(app.frame, 100, 80, 700, 700);
  await app.client.waitForRenderIdle();
  const narrow = await app.client.layout();
  const content = narrow.items.canvas;
  assert.ok(
    content.rect.dx > 150,
    "narrow windows must retain usable document space",
  );
  assert.ok(
    (await notesWidth()) < wanted,
    "width must clamp inside a narrow frame",
  );
  moveWindow(app.frame, 100, 80, 1280, 900);
  await app.client.waitForRenderIdle();
  assert.ok(
    Math.abs((await notesWidth()) - wanted) <= 2,
    "temporary clamp must not overwrite preferred width",
  );
  sendCommandSync(app.frame, cmdId("CmdTogglePresentationMode"));
  await Bun.sleep(100);
  assert.equal(
    await splitter(),
    undefined,
    "presentation must hide the notes splitter",
  );
  sendCommandSync(app.frame, cmdId("CmdTogglePresentationMode"));
  await app.client.waitForRenderIdle();
  assert.ok(Math.abs((await notesWidth()) - wanted) <= 2);
  await stop();
  const preferences = readFileSync(
    join(data, "SumatraPDF-settings.txt"),
    "utf8",
  );
  assert.match(preferences, /^ContextNotesWidth\s*=\s*[1-9]\d*/m);
  assert.match(
    preferences,
    /^SidebarDx\s*=\s*240\s*$/m,
    "notes resizing must not change TOC width",
  );
  assert.match(
    preferences,
    /^DefaultZoom\s*=\s*125\s*$/m,
    "notes resizing must not change document zoom",
  );
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", pdf],
    { saveSettings: true },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  await Bun.sleep(500);
  assert.ok(
    Math.abs((await notesWidth()) - wanted) <= 2,
    "width must persist across restart",
  );
  console.log(
    "PASS: notes splitter drags, persists, clamps and hides correctly without changing TOC width or document zoom.",
  );
  console.log(`Artifacts: ${output}`);
} finally {
  await stop();
}
