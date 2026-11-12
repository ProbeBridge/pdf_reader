// Run after an ng Mac build; uses a temporary 6000-bookmark document.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-toc-"));
const count = 6000;
const content = "BT /F1 16 Tf 50 700 Td (Portable reader bookmarks) Tj ET\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageMode /UseOutlines >>",
  "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Type /Outlines /First 7 0 R /Last ${count + 6} 0 R /Count ${count} >>`,
];
for (let i = 0; i < count; i++) {
  objects.push(
    `<< /Title (Chapter ${i + 1} - portable reading) /Parent 6 0 R /Dest [3 0 R /Fit] ${i ? `/Prev ${i + 6} 0 R` : ""} ${i < count - 1 ? `/Next ${i + 8} 0 R` : ""} >>`,
  );
}
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, object] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const path = join(dir, "bookmarks.pdf");
writeFileSync(path, pdf);
writeFileSync(join(dir, "SumatraPDF-settings.txt"), "CheckForUpdates = false\nRestoreSession = false\n");
const pipe = `toc-${process.pid}-${Date.now()}`;
const child = spawn(
  process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
  ["-for-testing", "-appdata", dir, "-dbg-control", pipe, path],
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
    assert.equal(reply[0], 0, String(reply));
    return String(reply[1] ?? "");
  };
  const until = async (get: () => Promise<string>, valid: (s: string) => boolean) => {
    const end = Date.now() + 15000;
    for (;;) {
      const s = await get();
      if (valid(s)) return s;
      assert.ok(Date.now() < end, s);
      await Bun.sleep(40);
    }
  };
  await until(
    () => request("TestUiState"),
    (s) => s.includes("tocItems=6000"),
  );
  const initial = await request("TestUiState");
  if (!/ toc=1/.test(initial)) await request("TestInvokeCommand", "CmdToggleBookmarks");
  await until(
    () => request("TestUiState"),
    (s) => s.includes("tocRows=6000"),
  );
  assert.equal(await request("TestUiState", "focus"), "ok");
  const before = await request("TestTocRows");
  const height = (s: string) => Number(/rowDy=(\d+)/.exec(s)![1]);
  assert.equal(height(before), 18);
  const key = async (vk: number) => {
    await request("TestInput", "key", vk, 1);
    await request("TestInput", "keyup", vk, 1);
  };
  await key(187);
  const larger = await until(
    () => request("TestTocRows"),
    (s) => height(s) > 18,
  );
  assert.equal((larger.match(/row y=/g) || []).length, count);
  await key(48);
  await until(
    () => request("TestTocRows"),
    (s) => height(s) === 18,
  );
  const start = performance.now();
  for (let i = 0; i < 5; i++) await request("TestUiState");
  assert.ok(performance.now() - start < 5000, "6000-row directory stopped responding");
  console.log("PASS 6000 bookmarks, font scaling/reset, row geometry and control response");
  await request("Quit");
  await exited;
} finally {
  socket?.destroy();
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
