// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-reflow.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

export async function testit() {
  const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-reflow-"));
  const pipe = `reflow-${process.pid}-${Date.now()}`;
  writeFileSync(
    join(dir, "SumatraPDF-settings.txt"),
    "RestoreSession = false\nCheckForUpdates = false\nUiLanguage = en\nTheme = Light\n",
  );
  const child = spawn(
    process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
    [
      "-for-testing",
      "-appdata",
      dir,
      "-dbg-control",
      pipe,
      "-log-to-file",
      join(dir, "app.log"),
      resolve("ext/a-zlib/zlib.3.pdf"),
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
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
    const toolbar = await until(
      () => request("TestToolbarButtons"),
      (s) => /text=Reflow document text/.test(s),
    );
    const reflow = toolbarRect(toolbar, "Reflow document text");
    const zoom = toolbarRect(toolbar, "Zoom In");
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
    assert.equal(await evaluate("reflow", "document.documentElement.dataset.theme"), "light");
    console.log("PASS visible text switch opens real PDF reflow; View menu and check state are available");

    await evaluate("reflow", "(document.querySelector('[data-theme-toggle]').click(),true)");
    await until(
      async () => String(await evaluate("reflow", "document.documentElement.dataset.theme")),
      (s) => s === "dark",
    );
    await request("TestInvokeCommand", "CmdContextNotes");
    await until(
      () => request("TestUiState"),
      (s) => s.includes("notesReady=1"),
    );
    assert.equal(await evaluate("notes", "document.documentElement.dataset.theme"), "dark");
    await evaluate("notes", "(document.querySelector('[data-theme-toggle]').click(),true)");
    await until(
      async () => String(await evaluate("reflow", "document.documentElement.dataset.theme")),
      (s) => s === "light",
    );
    console.log("PASS dark/light theme changes stay synchronized between native notes and reflow");

    await request("TestInvokeCommand", "CmdZoomIn");
    await until(
      async () => String(await evaluate("reflow", "document.querySelector('#page-label').textContent")),
      (s) => s.includes("110%"),
    );
    await evaluate("reflow", "(document.querySelector('#original').click(),true)");
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
    await request("Quit");
    await exited;
  } finally {
    socket?.destroy();
    child.kill();
    if (process.env.KEEP_TEST_ARTIFACTS) console.log(`Artifacts: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await testit();
