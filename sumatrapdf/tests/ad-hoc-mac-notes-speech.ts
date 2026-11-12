// Real WKWebView audio scheduling and GPUI hover buttons, with a held local LLM reply.
// The real audio graph is muted so verification does not interrupt the user's audio.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

const dir = mkdtempSync(join(tmpdir(), "sumatra-notes-speech-"));
const content = "BT /F1 16 Tf 220 400 Td (Portable) Tj ET\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, obj] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
}
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const document = join(dir, "portable.pdf");
writeFileSync(document, pdf);
writeFileSync(join(dir, "SumatraPDF-settings.txt"), "CheckForUpdates = false\nRestoreSession = false\n");
let response: ServerResponse | undefined;
let requests = 0;
let completed = false;
const server = createServer((req, res) => {
  req.resume();
  requests++;
  response = res;
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const pipe = `notes-speech-${process.pid}-${Date.now()}`;
const child = spawn(
  process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF"),
  ["-for-testing", "-appdata", dir, "-dbg-control", pipe, "-log-to-file", join(dir, "app.log"), document],
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
  const until = async (get: () => Promise<string>, valid: (s: string) => boolean, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await get();
      if (valid(s)) return s;
      assert.ok(Date.now() < end, s);
      await Bun.sleep(60);
    }
  };
  const evaluate = async (script: string, surface = "notes") => {
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
  await until(
    () => request("TestCurrentTab"),
    (s) => s.includes("portable.pdf"),
  );
  await request("TestInvokeCommand", "CmdContextNotes");
  await until(
    () => request("TestUiState"),
    (s) => s.includes("notesReady=1"),
  );
  await evaluate(
    `import('./shared/settings.js').then(async m=>{await m.saveSettings(${JSON.stringify({ provider: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock", apiKey: "test-key", ipa: "off" })});return true})`,
  );
  await evaluate(`(()=>{window.speechStarts=[];window.speechEnds=[];const Original=window.AudioContext;window.AudioContext=class extends Original {
  createBufferSource(){const source=super.createBufferSource();const start=source.start.bind(source);
   const connect=source.connect.bind(source),muted=this.createGain();muted.gain.value=0;muted.connect(this.destination);
   source.connect=()=>connect(muted);source.addEventListener('ended',()=>window.speechEnds.push(performance.now()));
   source.start=(...args)=>{
   window.speechStarts.push({state:this.state,at:performance.now(),duration:source.buffer.duration});
   if(window.speechStarts.length===1)setTimeout(()=>{document.querySelector('.inline-speak').click();document.querySelector('.inline-speak').click()},20);
   return start(...args)};return source}
 };return true})()`);
  const state = await request("TestUiState");
  const canvas = /canvas=(-?\d+),(-?\d+),/.exec(state)!.slice(1).map(Number);
  const layout = await request("TestLayout");
  const page = /page n=1 .*pos=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(layout)!.slice(1).map(Number);
  const scale = Number(/canvasScale=([\d.]+)/.exec(layout)![1]);
  const x = Math.round(canvas[0]! + (page[0]! + (240 * page[2]!) / 612) * scale);
  const y = Math.round(canvas[1]! + (page[1]! + ((792 - 405) * page[3]!) / 792) * scale);
  await request("TestInput", "click", x, y);
  await until(
    async () => String(requests),
    (s) => Number(s) === 1,
  );
  await until(
    async () => String((await evaluate("window.speechStarts")).length),
    (s) => Number(s) === 1,
    30000,
  );
  assert.equal(completed, false);
  assert.equal((await evaluate("window.speechStarts"))[0].state, "running", "Web Audio autoplay remained suspended");
  await until(
    async () => String((await evaluate("window.speechEnds")).length),
    (s) => Number(s) === 1,
  );
  const firstSpeech = (await evaluate("window.speechStarts"))[0];
  assert.equal((await evaluate("window.speechStarts")).length, 1, "Repeated play interrupted the current word");
  assert.ok(
    (await evaluate("window.speechEnds"))[0] - firstSpeech.at >= firstSpeech.duration * 1000 - 100,
    "Repeated play cut off the word before its audio buffer ended",
  );
  response!.writeHead(200, { "Content-Type": "text/event-stream" });
  response!.end(
    "data: " +
      JSON.stringify({ choices: [{ delta: { content: "可移植\n\n可在不同平台使用。" } }] }) +
      "\n\ndata: [DONE]\n\n",
  );
  completed = true;
  await until(
    async () => String(await evaluate("document.querySelector('.meaning')?.textContent")),
    (s) => s.includes("可移植"),
  );
  assert.equal((await evaluate("window.speechStarts")).length, 1);
  console.log("PASS speech plays once while LLM response is pending; repeated play preserves the complete word");
  const word = JSON.parse(
    await until(
      () => request("TestUiState", "notes", "anchor"),
      (s) => s.startsWith("{"),
    ),
  );
  await request("TestInput", "move", word.x, word.y);
  const popup = await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=1") && /noteActionRect=\d+,\d+,[1-9]/.test(s),
  );
  const bounds = /noteActionRect=(\d+),(\d+),(\d+),(\d+)/.exec(popup)!.slice(1).map(Number);
  const bx = bounds[0]! + 17,
    by = bounds[1]! + bounds[3]! / 2;
  await request("TestInput", "move", Math.round(bx), Math.round(by));
  assert.ok((await request("TestUiState")).includes("noteActions=1"));
  await request("TestInput", "click", Math.round(bx), Math.round(by));
  await until(
    async () => String((await evaluate("window.speechStarts")).length),
    (s) => Number(s) === 2,
  );
  await until(
    async () => String((await evaluate("window.speechEnds")).length),
    (s) => Number(s) === 2,
  );
  await request("TestInput", "move", 2, canvas[1]! + 5);
  await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=0"),
  );
  console.log("PASS native word hover exposes play/delete; toolbar retains pointer and manual replay works");
  await request("TestInvokeCommand", "CmdToggleDocumentReflow");
  await until(
    () => request("TestUiState"),
    (s) => s.includes("reflowReady=1"),
  );
  const id = await evaluate("document.querySelector('.card').dataset.id");
  await evaluate(`__sumatra__.call('reflow',JSON.stringify({action:'speak',id:${JSON.stringify(id)}}))`, "reflow");
  await until(
    async () => String((await evaluate("window.speechStarts")).length),
    (s) => Number(s) === 3,
  );
  await until(
    async () => String((await evaluate("window.speechEnds")).length),
    (s) => Number(s) === 3,
  );
  console.log("PASS reflow play action reaches shared cached speech");
  await request("TestInvokeCommand", "CmdToggleDocumentReflow");
  await until(
    () => request("TestUiState"),
    (s) => s.includes("reflowVisible=0"),
  );
  const restored = JSON.parse(
    await until(
      () => request("TestUiState", "notes", "anchor"),
      (s) => s.startsWith("{"),
    ),
  );
  await request("TestInput", "move", restored.x, restored.y);
  await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=1"),
  );
  await request("TestInput", "key", 27, 0);
  await request("TestInput", "keyup", 27, 0);
  await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=0"),
  );
  await request("TestInput", "move", restored.x + 1, restored.y);
  const deletePopup = await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=1"),
  );
  const deleteBounds = /noteActionRect=(\d+),(\d+),(\d+),(\d+)/.exec(deletePopup)!.slice(1).map(Number);
  await request("TestInput", "click", deleteBounds[0]! + 52, Math.round(deleteBounds[1]! + deleteBounds[3]! / 2));
  await until(
    async () => String(await evaluate("document.querySelectorAll('.card').length")),
    (s) => s === "0",
  );
  await until(
    () => request("TestUiState"),
    (s) => s.includes("noteActions=0"),
  );
  console.log("PASS Escape and delete dismiss the native note action toolbar");

  await request("Quit");
  await exited;
} finally {
  socket?.destroy();
  child.kill();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  if (process.env.KEEP_TEST_ARTIFACTS) console.log(`Artifacts: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
