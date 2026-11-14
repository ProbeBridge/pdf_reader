// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-store.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

// Two distinct pages prove the cover uses page one, including after a file update.
function coverPdf(color: string) {
  const stream = (rgb: string) => {
    const body = `${rgb} rg 0 0 200 300 re f\n`;
    return `<< /Length ${body.length} >>\nstream\n${body}endstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 4 0 R >>",
    stream(color),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 6 0 R >>",
    stream("0 1 0"),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function testit() {
  const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-store-"));
  const sharedPath = join(dir, "Shared book.pdf");
  const book = { path: sharedPath, name: "Shared book.pdf", addedAt: Date.now() };
  const manifest = JSON.stringify({ [`library:${sharedPath}`]: JSON.stringify(book) });
  try {
    for (const account of ["first", "second", "first"]) {
      writeFileSync(sharedPath, coverPdf("1 0 0"));
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
        const cover = await evaluate(call({ action: "libraryCover", path: sharedPath }));
        assert.match(cover.image, /^data:image\/png;base64,/);
        const colorAtCenter = (uri: string) =>
          `(async()=>{const image=new Image();image.src=${JSON.stringify(uri)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(canvas.width>>1,canvas.height>>1,1,1).data]})()`;
        assert.deepEqual(await evaluate(colorAtCenter(cover.image)), [255, 0, 0, 255]);
        const cached = await evaluate(call({ action: "libraryCover", path: sharedPath }));
        assert.equal(cached.cached, true);
        assert.equal(cached.image, cover.image);
        writeFileSync(sharedPath, coverPdf("0 0 1"));
        const changedAt = new Date(Date.now() + 2000);
        utimesSync(sharedPath, changedAt, changedAt);
        const changed = await evaluate(call({ action: "libraryCover", path: sharedPath }));
        assert.equal(changed.cached, false);
        assert.deepEqual(await evaluate(colorAtCenter(changed.image)), [0, 0, 255, 255]);
        copyFileSync(resolve("docs/test/encrypted.pdf"), sharedPath);
        const lockedAt = new Date(Date.now() + 4000);
        utimesSync(sharedPath, lockedAt, lockedAt);
        assert.equal((await evaluate(call({ action: "libraryCover", path: sharedPath }))).image, "");
        writeFileSync(sharedPath, coverPdf("0 0 1"));
        const restoredAt = new Date(Date.now() + 6000);
        utimesSync(sharedPath, restoredAt, restoredAt);
        assert.deepEqual(await evaluate(call({ action: "libraryCover", path: join(dir, "not-in-library.pdf") })), {
          image: "",
        });
        await evaluate("(document.querySelector('#library').click(),true)");
        await until(
          async () => String(await evaluate("document.querySelectorAll('.book-title').length")),
          (s) => s === "1",
        );
        assert.equal(await evaluate("document.querySelectorAll('.book-remove').length"), 0);
        assert.equal(await evaluate("document.querySelectorAll('.book-shared').length"), 1);
        await until(
          async () => String(await evaluate("Boolean(document.querySelector('.book-cover img')?.naturalWidth)")),
          (s) => s === "true",
        );
        await evaluate("(document.querySelector('#library-view-list').click(),true)");
        assert.equal(await evaluate("document.querySelector('#books').dataset.view"), "list");
        await until(
          async () => String((await evaluate(call({ action: "read" })))["ui:library"]?.view),
          (s) => s === "list",
        );
        await request("TestUiState", "notes", "history", "document.querySelector('.book-title').click()");
        await until(
          () => request("TestUiState"),
          (s) => /page=[1-9]\d*\b/.test(s),
        );
        assert.ok((await request("TestCurrentTab")).includes(book.name));
        await request("TestInvokeCommand", "CmdNewWindow");
        await request("Quit");
        const exit = await exited;
        assert.equal(exit.signal, null, `App shutdown crashed: ${exit.signal}`);
        assert.equal(exit.code, 0, "App shutdown must succeed");
        assert.equal(readFileSync(join(data, "context-notes.dat"), "utf8"), store);
        console.log(
          `PASS ${account}: private JSON, shared opening, first-page covers, cache invalidation, protected-file fallback and list view`,
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
