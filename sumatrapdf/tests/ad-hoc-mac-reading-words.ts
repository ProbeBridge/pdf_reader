// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-reading-words.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

function fixturePdf() {
  const stream = (text: string) => {
    const body = `BT /F1 13 Tf 50 700 Td (${text}) Tj ET\n`;
    return `<< /Length ${body.length} >>\nstream\n${body}endstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream("Alpha beta don't e.g. words."),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("One two three four five six."),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function testit() {
  const dir = mkdtempSync(join(tmpdir(), "sumatra-reading-words-"));
  const path = join(dir, "Eleven words.pdf");
  writeFileSync(path, fixturePdf());
  writeFileSync(
    join(dir, "SumatraPDF-settings.txt"),
    "RestoreSession = false\nCheckForUpdates = false\nTheme = Light\n",
  );
  try {
    for (const run of ["first", "reopened"]) {
      const pipe = `reading-words-${process.pid}-${Date.now()}`;
      const child = spawn(
        process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
        [
          "-for-testing",
          "-appdata",
          dir,
          "-dbg-control",
          pipe,
          "-log-to-file",
          join(dir, `${run}.log`),
          "-view",
          "single page",
          "-zoom",
          "100",
          path,
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
        const until = async (get: () => Promise<string>, valid: (value: string) => boolean) => {
          const end = Date.now() + 25000;
          for (;;) {
            const value = await get();
            if (valid(value)) return value;
            assert.ok(Date.now() < end, value);
            await Bun.sleep(100);
          }
        };
        const evaluate = async (surface: string, script: string) => {
          await until(
            () => request("TestUiState", "notes", surface, script),
            (value) => value !== "not-ready",
          );
          const result = JSON.parse(
            await until(
              () => request("TestUiState", "notes", surface),
              (value) => value.startsWith("{"),
            ),
          );
          assert.equal(result.ok, true, JSON.stringify(result));
          return result.value;
        };
        const call = (action: unknown) => `__sumatra__.call('notes',${JSON.stringify(JSON.stringify(action))})`;
        await until(
          () => request("TestCurrentTab"),
          (value) => value.includes("Eleven words.pdf"),
        );
        await request("TestInvokeCommand", "CmdContextNotes");
        await until(
          () => request("TestUiState"),
          (value) => value.includes("notesReady=1"),
        );
        const pageWords = (records: Record<string, any>) =>
          Object.values(records).find((value) => value.kind === "reading")?.pageWords || {};
        await until(
          async () => JSON.stringify(pageWords(await evaluate("notes", call({ action: "readingStats" })))),
          (value) => JSON.parse(value)["1"] === 5,
        );
        if (run === "first") {
          await request("TestInvokeCommand", "CmdReadingHistory");
          await until(
            () => request("TestUiState"),
            (value) => /page=0\b/.test(value),
          );
          await evaluate("history", "(document.querySelector('#stats-tab').click(), true)");
          await until(
            async () =>
              String(await evaluate("history", "document.querySelector('[data-stat=wordRatio]')?.textContent")),
            (value) => value === "—",
          );
          await request("TestOpenFiles", path);
          await until(
            () => request("TestCurrentTab"),
            (value) => value.includes("Eleven words.pdf"),
          );
          for (const [id, quote] of [
            ["phrase", "Alpha beta"],
            ["phrase", "Ignore these duplicate words"],
            ["punctuation", "don't e.g."],
            ["cjk", "中文"],
            ["legacy", undefined],
          ]) {
            assert.equal(
              await evaluate("notes", call({ action: "recordVocabulary", id, quote, createdAt: Date.now() })),
              true,
            );
          }
          await request("TestInvokeCommand", "CmdGoToNextPage");
          await until(
            async () => JSON.stringify(pageWords(await evaluate("notes", call({ action: "readingStats" })))),
            (value) => JSON.parse(value)["2"] === 6,
          );
          await request("TestInvokeCommand", "CmdGoToPrevPage");
        }
        const records = await evaluate("notes", call({ action: "readingStats" }));
        assert.deepEqual(pageWords(records), { 1: 5, 2: 6 });
        const vocabulary = Object.values(records).find((value: any) => value.kind === "vocabulary") as any;
        assert.equal(vocabulary.ids.length, 4);
        assert.deepEqual(vocabulary.wordCounts, { phrase: 2, punctuation: 2, cjk: 2 });
        await request("TestInvokeCommand", "CmdReadingHistory");
        await until(
          () => request("TestUiState"),
          (value) => /page=0\b/.test(value),
        );
        await evaluate("history", "(document.querySelector('#stats-tab').click(), true)");
        await until(
          async () => String(await evaluate("history", "document.querySelector('[data-stat=wordRatio]')?.textContent")),
          (value) => value === "1.83 : 1",
        );
        for (const period of ["day", "week", "month", "year"]) {
          await evaluate(
            "history",
            `(()=>{const e=document.querySelector('#stats-range');e.value=${JSON.stringify(period)};e.dispatchEvent(new Event('change'));return true})()`,
          );
          assert.equal(
            await evaluate("history", "document.querySelector('[data-stat=readingWords]').textContent"),
            "11",
          );
          assert.equal(
            await evaluate("history", "document.querySelector('[data-stat=annotationWords]').textContent"),
            "6",
          );
          assert.equal(
            await evaluate("history", "document.querySelector('[data-stat=wordRatio]').textContent"),
            "1.83 : 1",
          );
        }
        await request("Quit");
        assert.deepEqual(await exited, { code: 0, signal: null });
        // Testing mode intentionally never saves the store. Reload an exported
        // fixture in the next process to check the persisted record format.
        if (run === "first")
          writeFileSync(
            join(dir, "context-notes.dat"),
            JSON.stringify(
              Object.fromEntries(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)])),
            ),
            { mode: 0o600 },
          );
        const persisted = JSON.parse(readFileSync(join(dir, "context-notes.dat"), "utf8"));
        assert.ok(Object.values(persisted).some((value) => JSON.parse(String(value)).pageWords?.["2"] === 6));
        console.log(
          `PASS ${run}: actual PDF word counts, page/note deduplication, phrases/CJK, legacy records, all calendar ratios and clean shutdown`,
        );
      } finally {
        socket?.destroy();
        child.kill();
      }
    }
  } finally {
    if (process.env.KEEP_TEST_ARTIFACTS) console.log(`Artifacts: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) await testit();
