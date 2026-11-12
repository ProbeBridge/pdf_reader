// Run from sumatrapdf/: ../node_modules/.bin/bun tests/ad-hoc-mac-notes.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { connect, sendCommand, controlCommands as C } from "../cmd/ng-dbg-control.ts";

const dir = mkdtempSync(join(tmpdir(), "sumatra-mac-notes-"));
const pipe = `notes-${process.pid}-${Date.now()}`;
writeFileSync(join(dir, "SumatraPDF-settings.txt"), "RestoreSession = false\nCheckForUpdates = false\n");
const server = createServer((req, res) => {
  if (req.url === "/v1/chat/completions") {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "可移植\n\n适用于不同平台。" } }] }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/unexpected" });
    res.end();
    return;
  }
  if (req.url === "/unexpected") throw new Error("Credentials followed a redirect");
  res.writeHead(req.url === "/error" ? 429 : 200, { "Content-Type": "text/plain" });
  res.write("first");
  const timer = setTimeout(() => res.end(`-${req.method}-last`), req.url === "/slow" ? 2000 : 20);
  res.on("close", () => clearTimeout(timer));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const exe = process.env.SUMATRA_TEST_EXE || resolve("out/mac/dbg/SumatraPDF");
const child = spawn(
  exe,
  [
    "-for-testing",
    "-appdata",
    dir,
    "-log-to-file",
    join(dir, "app.log"),
    "-dbg-control",
    pipe,
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
  const until = async (get: () => Promise<string>, valid: (s: string) => boolean, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const s = await get();
      if (valid(s)) return s;
      assert.ok(Date.now() < end, `Timed out: ${s}`);
      await Bun.sleep(50);
    }
  };
  const evaluate = async (surface: string, script: string) => {
    await until(
      () => request("TestUiState", "notes", surface, script),
      (s) => s !== "not-ready",
    );
    const raw = await until(
      () => request("TestUiState", "notes", surface),
      (s) => s.startsWith("{"),
    );
    const result = JSON.parse(raw);
    assert.equal(result.ok, true, raw);
    return result.value;
  };
  const call = (action: unknown) => `__sumatra__.call('notes',${JSON.stringify(JSON.stringify(action))})`;
  await until(
    () => request("TestCurrentTab"),
    (s) => s.includes("zlib.3.pdf"),
  );
  await request("TestInvokeCommand", "CmdContextNotes");
  await until(
    () => request("TestUiState"),
    (s) => /notesReady=1/.test(s),
  );
  assert.equal(await evaluate("notes", "document.title"), "AI 注释");
  assert.equal(
    await evaluate("notes", call({ action: "write", key: "test", value: '{"text":"portable"}', expected: "null" })),
    true,
  );
  assert.deepEqual(await evaluate("notes", call({ action: "read" })), { test: { text: "portable" } });
  assert.deepEqual(await evaluate("notes", call({ action: "write", key: "test", value: "{}", expected: "null" })), {
    conflict: true,
  });
  assert.equal(await evaluate("notes", call({ action: "remove", key: "test" })), true);
  console.log("PASS WKWebView assets, promise bridge and transactional note storage");
  for (const [path, method, status] of [
    ["/stream", "GET", 200],
    ["/stream", "POST", 200],
    ["/error", "GET", 429],
    ["/redirect", "GET", 302],
  ] as const) {
    const fetch = {
      action: "fetch",
      id: path + method,
      url: `http://127.0.0.1:${port}${path}`,
      method,
      headers: JSON.stringify({ Authorization: "Bearer test" }),
      body: method === "POST" ? "payload" : "",
    };
    const result = await evaluate(
      "notes",
      `new Promise((resolve,reject)=>{
      const result={chunks:[],status:0};
      const listener=e=>{const d=e.detail;if(d.id!==${JSON.stringify(fetch.id)})return;
        if(d.status)result.status=d.status;if(d.chunk)result.chunks.push(atob(d.chunk));
        if(d.done||d.error){removeEventListener('netevent',listener);d.error?reject(d.error):resolve(result)}};
      addEventListener('netevent',listener);${call(fetch)}.catch(reject);
    })`,
    );
    assert.equal(result.status, status);
    if (status !== 302) assert.equal(result.chunks.join(""), `first-${method}-last`);
  }
  const cancelled = await evaluate(
    "notes",
    `new Promise((resolve,reject)=>{
    const events=[];let stop=false;
    const listener=async e=>{const d=e.detail;if(d.id!=='cancel-test')return;
      events.push(d);if(d.chunk&&!stop){stop=true;await __sumatra__.call('notes',JSON.stringify({action:'cancelFetch',id:'cancel-test'}));
      setTimeout(()=>{removeEventListener('netevent',listener);resolve(events)},1200)}};
    addEventListener('netevent',listener);
    __sumatra__.call('notes',JSON.stringify({action:'fetch',id:'cancel-test',url:'http://127.0.0.1:${port}/slow',method:'GET',headers:'{}',body:''})).catch(reject);
  })`,
  );
  assert.ok(cancelled.some((event: { chunk?: string }) => event.chunk));
  assert.ok(!cancelled.some((event: { done?: boolean; error?: string }) => event.done || event.error));
  console.log("PASS native GET/POST streaming, HTTP errors, redirect isolation and cancellation");
  const tts = await evaluate(
    "notes",
    `new Promise(resolve=>{
    let w, timer=setTimeout(()=>{w?.terminate();resolve({neural:false,reason:'timeout',system:speechSynthesis.getVoices().length})},10000);
    const done=value=>{clearTimeout(timer);w?.terminate();resolve(value)};
    try {w=new Worker(new URL('./shared/tts-worker.js',location.href),{type:'module'});
      w.onmessage=e=>done({neural:!!e.data.audio?.length,reason:e.data.error||'',system:speechSynthesis.getVoices().length});
      w.onerror=e=>{e.preventDefault();done({neural:false,reason:e.message||'worker unavailable',system:speechSynthesis.getVoices().length})};
      w.postMessage({id:1,text:'Portable.',voice:'af_bella',speed:0.8});
    } catch(e) {done({neural:false,reason:String(e),system:speechSynthesis.getVoices().length})}
  })`,
  );
  assert.ok(tts.neural || tts.system > 0, JSON.stringify(tts));
  console.log(`PASS Mac offline speech: ${JSON.stringify(tts)}`);
  await evaluate(
    "notes",
    call({
      action: "write",
      key: "settings",
      value: JSON.stringify({
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "mock",
        apiKey: "test-key",
        ipa: "off",
      }),
    }),
  );
  await request("TestInvokeCommand", "CmdSelectCurrentPage");
  await request("TestInvokeCommand", "CmdContextAnnotate");
  await until(
    async () => String(await evaluate("notes", "document.querySelector('.meaning')?.textContent")),
    (s) => s.includes("可移植"),
  );
  console.log("PASS PDF selection → native API → rendered AI annotation");
  await request("TestInvokeCommand", "CmdToggleDocumentReflow");
  await until(
    () => request("TestUiState"),
    (s) => /reflowReady=1/.test(s),
  );
  const page = await evaluate("reflow", `__sumatra__.call('reflow',JSON.stringify({action:'page',page:1}))`);
  assert.ok(page.html.length > 0 && page.sourceText.length > 0);
  const again = await evaluate("reflow", `__sumatra__.call('reflow',JSON.stringify({action:'page',page:1}))`);
  assert.equal(again.cached, true);
  assert.equal(again.sourceText, page.sourceText);
  await request("TestInvokeCommand", "CmdZoomIn");
  await request("TestInvokeCommand", "CmdToggleDocumentReflow");
  await until(
    () => request("TestUiState"),
    (s) => /reflowVisible=0/.test(s),
  );
  console.log("PASS native reflow extraction, XHTML cache, zoom and return to PDF");
  await request("TestInvokeCommand", "CmdReadingHistory");
  await until(
    () => request("TestUiState"),
    (s) => /page=0/.test(s),
  );
  const history = await evaluate("history", call({ action: "history" }));
  assert.ok(Array.isArray(history));
  console.log("PASS WKWebView reading history");
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
