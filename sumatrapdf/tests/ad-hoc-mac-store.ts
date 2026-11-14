// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-store.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

export async function testit() {
  const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-store-"));
  const sharedPath = join(dir, "Shared book.pdf");
  copyFileSync(resolve("ext/a-zlib/zlib.3.pdf"), sharedPath);
  const book = { path: sharedPath, name: "Shared book.pdf", addedAt: Date.now() };
  const manifest = JSON.stringify({ [`library:${sharedPath}`]: JSON.stringify(book) });
  try {
    for (const account of ["first", "second", "first"]) {
      const data = join(dir, account);
      mkdirSync(data, { recursive: true });
      const store = JSON.stringify({
        settings: JSON.stringify({ apiKey: `LOCAL_TEST_${account}` }),
        [`page:${account}`]: JSON.stringify({ annotations: [{ quote: `${account} 中文` }] }),
      });
      writeFileSync(join(data, "context-notes.dat"), store, { mode: 0o600 });
      writeFileSync(join(data, "shared-library.json"), manifest);
      writeFileSync(join(data, "SumatraPDF-settings.txt"), "RestoreSession = false\nCheckForUpdates = false\n");
      const pipe = `store-${process.pid}-${Date.now()}`;
      const child = spawn(
        process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
        ["-for-testing", "-appdata", data, "-dbg-control", pipe, "-log-to-file", join(data, "app.log")],
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
        const evaluate = async (script: string) => {
          await until(
            () => request("TestUiState", "notes", "history", script),
            (s) => s !== "not-ready" && s !== "no-view",
          );
          const result = JSON.parse(
            await until(
              () => request("TestUiState", "notes", "history"),
              (s) => s.startsWith("{"),
            ),
          );
          assert.equal(result.ok, true, JSON.stringify(result));
          return result.value;
        };
        const call = (action: unknown) => `__sumatra__.call('notes',${JSON.stringify(JSON.stringify(action))})`;
        await request("TestInvokeCommand", "CmdReadingHistory");
        const all = await evaluate(call({ action: "read" }));
        assert.equal(all.settings.apiKey, `LOCAL_TEST_${account}`);
        assert.equal(all[`page:${account}`].annotations[0].quote, `${account} 中文`);
        assert.equal(all[`page:${account === "first" ? "second" : "first"}`], undefined);
        const books = await evaluate(call({ action: "library" }));
        assert.equal(books.length, 1);
        assert.equal(books[0].shared, true);
        assert.equal(books[0].book.path, sharedPath);
        await evaluate("(document.querySelector('#library').click(),true)");
        await until(
          async () => String(await evaluate("document.querySelectorAll('.book-title').length")),
          (s) => s === "1",
        );
        assert.equal(await evaluate("document.querySelectorAll('.book-remove').length"), 0);
        assert.equal(await evaluate("document.querySelectorAll('.book-shared').length"), 1);
        await request("TestUiState", "notes", "history", "document.querySelector('.book-title').click()");
        await until(
          () => request("TestUiState"),
          (s) => /page=[1-9]\d*\b/.test(s),
        );
        assert.ok((await request("TestCurrentTab")).includes(book.name));
        await request("Quit");
        await exited;
        assert.equal(readFileSync(join(data, "context-notes.dat"), "utf8"), store);
        console.log(
          `PASS ${account}: plain notes and API key load, shared library opens, personal data stays separate`,
        );
      } finally {
        socket?.destroy();
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await testit();
