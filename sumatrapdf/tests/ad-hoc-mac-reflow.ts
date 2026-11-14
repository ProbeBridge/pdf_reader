// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-reflow.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

export async function testit() {
  const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-reflow-"));
  const pipe = `reflow-${process.pid}-${Date.now()}`;
  const source = resolve("ext/a-zlib/zlib.3.pdf");
  const bookPath = join(dir, "Unopened library book.pdf");
  const book = { path: bookPath, name: "Unopened library book.pdf", addedAt: Date.now() };
  const bookKey = `library:${bookPath}`;
  copyFileSync(source, bookPath);
  writeFileSync(
    join(dir, "SumatraPDF-settings.txt"),
    "RestoreSession = false\nCheckForUpdates = false\nUiLanguage = cn\nTheme = Light\n",
  );
  const child = spawn(
    process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
    [
      "-for-testing",
      ...(process.env.SUMATRA_TEST_NATIVE_LANG ? ["-lang", process.env.SUMATRA_TEST_NATIVE_LANG] : []),
      "-appdata",
      dir,
      "-dbg-control",
      pipe,
      "-log-to-file",
      join(dir, "app.log"),
      source,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    socket = await connect(pipe, 15000);
    const request = async (cmd: string, ...args: (number | string)[]) => {
      let timer: ReturnType<typeof setTimeout>;
      const reply = await Promise.race([
        sendCommand(socket!, C[cmd]!, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${cmd} timeout`)), 15000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (cmd === "TestCurrentTab" && reply[0] === 2 && String(reply[1]).startsWith("NOTREADY"))
        return String(reply[1]);
      assert.equal(reply[0], 0, `${cmd}: ${reply}`);
      return String(reply[1] ?? "");
    };
    const until = async (get: () => Promise<string>, valid: (s: string) => boolean) => {
      const end = Date.now() + 20000;
      for (;;) {
        const value = await get();
        if (valid(value)) return value;
        assert.ok(Date.now() < end, value);
        await Bun.sleep(60);
      }
    };
    const evaluate = async (surface: string, script: string) => {
      await until(
        () => request("TestUiState", "notes", surface, script),
        (s) => s !== "not-ready",
      );
      const result = JSON.parse(
        await until(
          () => request("TestUiState", "notes", surface),
          (s) => s.startsWith("{"),
        ),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const call = (action: unknown) => `__sumatra__.call('notes',${JSON.stringify(JSON.stringify(action))})`;
    const reflowCall = (action: unknown) => `__sumatra__.call('reflow',${JSON.stringify(JSON.stringify(action))})`;
    const toolbarRect = (dump: string, tip: string) => {
      const row = dump.split("\n").find((line) => line.startsWith("idx=") && line.includes(`text=${tip}`));
      assert.ok(row, `${tip} is missing from the toolbar`);
      assert.ok(row.includes("hidden=0"), row);
      const rect = /rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(row)!.slice(1).map(Number);
      assert.ok(rect[2]! > rect[0]! && rect[3]! > rect[1]!, row);
      return rect;
    };
    const reflowMenu = async (checked: boolean) => {
      const row = (await request("TestMainMenu"))
        .split("\n")
        .map((line) => line.split("\t"))
        .find((fields) => fields[2] === "CmdToggleDocumentReflow");
      assert.ok(row, "View menu must expose text reflow");
      assert.equal(row[3], "0", "Reflow menu item must be enabled for a text PDF");
      assert.equal(row[4], checked ? "1" : "0", "Reflow menu check must track the active view");
      assert.ok(row[6]?.includes("R"), "Reflow menu must show its keyboard shortcut");
    };
    const clickReflow = async () => {
      const r = toolbarRect(await request("TestToolbarButtons"), "Reflow document text");
      await request("TestInput", "click", Math.round((r[0]! + r[2]!) / 2), Math.round((r[1]! + r[3]!) / 2));
    };
    await until(
      () => request("TestCurrentTab"),
      (s) => s.includes("zlib.3.pdf"),
    );
    const languageState = await request("TestUiState");
    const language = / language=(\S+)/.exec(languageState)![1];
    const systemLanguage = / systemLanguage=(\S+)/.exec(languageState)![1];
    assert.equal(
      language,
      process.env.SUMATRA_TEST_NATIVE_LANG || systemLanguage,
      "Default UI language must follow the system instead of the saved legacy language",
    );
    const menu = await request("TestMainMenu");
    if (language === "cn") assert.ok(menu.includes("文件"), "The Chinese native translation catalog must be bundled");
    const toolbar = await until(
      () => request("TestToolbarButtons"),
      (s) => /text=Reflow document text/.test(s),
    );
    const reflow = toolbarRect(toolbar, "Reflow document text");
    const zoom = toolbarRect(toolbar, "Zoom In");
    const theme = toolbarRect(toolbar, "Toggle Light/Dark Theme");
    await request(
      "TestInput",
      "click",
      Math.round((theme[0]! + theme[2]!) / 2),
      Math.round((theme[1]! + theme[3]!) / 2),
    );
    assert.ok(reflow[2]! - reflow[0]! > zoom[2]! - zoom[0]! + 16, "Reflow text switch needs room for its on/off label");
    await reflowMenu(false);
    await clickReflow();
    await until(
      () => request("TestUiState"),
      (s) => s.includes("reflowVisible=1") && s.includes("reflowReady=1"),
    );
    await until(
      async () => String(await evaluate("reflow", "document.querySelector('.page-content')?.textContent || ''")),
      (s) => s.toLowerCase().includes("zlib"),
    );
    await reflowMenu(true);
    assert.equal(await evaluate("reflow", "document.documentElement.dataset.theme"), "dark");
    const originalLabel = await evaluate("reflow", "navigator.language.startsWith('zh') ? '原版' : 'Original view'");
    assert.equal(await evaluate("reflow", "document.querySelector('#original').textContent"), originalLabel);
    const typography = await evaluate(
      "reflow",
      "(()=>{const p=document.querySelector('.page-content'),s=getComputedStyle(p);return {font:parseFloat(s.fontSize),height:parseFloat(s.lineHeight),family:s.fontFamily,width:p.getBoundingClientRect().width,align:s.textAlign}})()",
    );
    assert.ok(typography.family.startsWith("Verdana"));
    assert.ok(typography.height >= typography.font * 1.5);
    assert.ok(typography.width <= typography.font * 40 + 1);
    assert.ok(["start", "left"].includes(typography.align));
    console.log("PASS visible text switch opens real PDF reflow; View menu and check state are available");

    for (const close of [
      { action: "close" },
      { action: "close", page: 1 },
      { action: "close", page: 1, glyph: null, x: null, y: null },
      { action: "close", page: 1, glyph: "bad", x: "bad", y: 0 },
      { action: "close", page: 1, glyph: -1, x: 1e200, y: 0 },
    ]) {
      await request("TestUiState", "notes", "reflow", reflowCall(close));
      await until(
        () => request("TestUiState"),
        (s) => s.includes("reflowVisible=0"),
      );
      assert.ok((await request("TestCurrentTab")).includes("zlib.3.pdf"));
      await clickReflow();
      await until(
        () => request("TestUiState"),
        (s) => s.includes("reflowVisible=1"),
      );
    }
    for (const page of [undefined, null, "1", 2147483648]) {
      const error = await evaluate(
        "reflow",
        `${reflowCall({ action: "page", page })}.then(()=>false,error=>String(error))`,
      );
      assert.match(error, /Invalid page/);
    }
    for (const action of [
      { action: "position" },
      { action: "position", page: 2 },
      { action: "zoom" },
      { action: "zoom", zoom: null },
    ])
      assert.equal(await evaluate("reflow", reflowCall(action)), true);
    assert.ok((await evaluate("reflow", "document.querySelector('#page-label').textContent")).includes("100%"));
    console.log("PASS reflow handles missing, partial, null and invalid numeric data without losing the document");

    await evaluate("reflow", "(document.querySelector('[data-theme-toggle]').click(),true)");
    await until(
      async () => String(await evaluate("reflow", "document.documentElement.dataset.theme")),
      (s) => s === "light",
    );
    await request("TestInvokeCommand", "CmdContextNotes");
    await until(
      () => request("TestUiState"),
      (s) => s.includes("notesReady=1"),
    );
    assert.equal(await evaluate("notes", "document.documentElement.dataset.theme"), "light");
    await evaluate("notes", "(document.querySelector('[data-theme-toggle]').click(),true)");
    await until(
      async () => String(await evaluate("reflow", "document.documentElement.dataset.theme")),
      (s) => s === "dark",
    );
    console.log("PASS dark/light theme changes stay synchronized between native notes and reflow");

    await request("TestInvokeCommand", "CmdZoomIn");
    await until(
      async () => String(await evaluate("reflow", "document.querySelector('#page-label').textContent")),
      (s) => s.includes("110%"),
    );
    // Hiding WKWebView can suspend its JS reply; observe the native view state.
    await request("TestUiState", "notes", "reflow", "document.querySelector('#original').click()");
    await until(
      () => request("TestUiState"),
      (s) => s.includes("reflowVisible=0"),
    );
    await reflowMenu(false);
    const shiftCommand = 2 | 16; // Debug-control Shift + Command flags.
    await request("TestInput", "key", "R".charCodeAt(0), shiftCommand);
    await request("TestInput", "keyup", "R".charCodeAt(0), shiftCommand);
    await until(
      () => request("TestUiState"),
      (s) => s.includes("reflowVisible=1"),
    );
    await clickReflow();
    await until(
      () => request("TestUiState"),
      (s) => s.includes("reflowVisible=0"),
    );
    await reflowMenu(false);
    console.log("PASS reflow zoom, web return button, Command-Shift-R and native toolbar toggles");

    await request("TestInvokeCommand", "CmdReadingHistory");
    await until(
      () => request("TestUiState"),
      (s) => /page=0\b/.test(s),
    );
    assert.deepEqual(await evaluate("history", call({ action: "library" })), []);
    assert.equal(
      await evaluate("history", call({ action: "write", key: bookKey, value: JSON.stringify(book), expected: "null" })),
      true,
    );
    await evaluate("history", "(document.querySelector('#library').click(),true)");
    await until(
      async () => String(await evaluate("history", "document.querySelector('.book-title')?.textContent")),
      (s) => s === book.name,
    );
    await request("TestUiState", "notes", "history", "document.querySelector('.book-title').click()");
    await until(
      () => request("TestCurrentTab"),
      (s) => s.includes(book.name),
    );
    await request("TestInvokeCommand", "CmdReadingHistory");
    await until(
      () => request("TestUiState"),
      (s) => /page=0\b/.test(s),
    );
    renameSync(bookPath, bookPath + ".moved");
    assert.equal((await evaluate("history", call({ action: "library" })))[0].missing, true);
    const missing = await evaluate(
      "history",
      `${call({ action: "open", path: bookPath })}.then(()=>false,error=>String(error))`,
    );
    assert.match(missing, /moved|unavailable/);
    await evaluate("history", "(document.querySelector('#library').click(),true)");
    await until(
      async () => String(await evaluate("history", "document.querySelectorAll('.book-status:not([hidden])').length")),
      (s) => s === "1",
    );
    await evaluate("history", "(document.querySelector('.book-remove').click(),true)");
    await until(
      async () => String(await evaluate("history", "document.querySelectorAll('.book-card').length")),
      (s) => s === "0",
    );
    assert.ok(existsSync(bookPath + ".moved"));
    await evaluate("history", "(document.querySelector('#toast button').click(),true)");
    await until(
      async () => String(await evaluate("history", "document.querySelectorAll('.book-card').length")),
      (s) => s === "1",
    );
    assert.deepEqual(readFileSync(bookPath + ".moved"), readFileSync(source));
    console.log(
      "PASS native library opens a new file, detects missing files, removes/undoes entries and preserves source bytes",
    );
    for (let i = 0; i < 2; i++)
      await evaluate(
        "history",
        call({ action: "recordVocabulary", id: "native-calendar-note", createdAt: Date.now() }),
      );
    await evaluate("history", "(document.querySelector('#statistics').click(),true)");
    await until(
      async () => String(await evaluate("history", "document.querySelector('[data-stat=words]')?.textContent")),
      (s) => s === "1",
    );
    assert.equal(await evaluate("history", "document.querySelectorAll('.stats-chart').length"), 1);
    for (const period of ["day", "week", "month", "year"]) {
      await evaluate(
        "history",
        `(()=>{const range=document.querySelector('#stats-range');range.value=${JSON.stringify(period)};range.dispatchEvent(new Event('change'));return true})()`,
      );
      assert.equal(await evaluate("history", "document.querySelectorAll('.stats-legend-item').length"), 3);
      for (const metric of ["pages", "annotations", "seconds"])
        assert.equal(
          await evaluate("history", `document.querySelectorAll('.stats-bar[data-metric=${metric}]').length`),
          period === "day" ? 14 : period === "year" ? 5 : 12,
        );
    }
    console.log(
      "PASS native combined calendar chart renders pages, annotation count and reading time at every interval",
    );
    await request("Quit");
    const exit = await exited;
    assert.equal(exit.signal, null, "Native reflow shutdown must not crash");
    assert.equal(exit.code, 0);
  } finally {
    socket?.destroy();
    child.kill();
    if (process.env.KEEP_TEST_ARTIFACTS) console.log(`Artifacts: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await testit();
