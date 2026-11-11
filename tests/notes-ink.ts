import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `notes-ink-${Date.now()}`);
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
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const { assemblePdf } = await import("../sumatrapdf/tests/util.ts");
const content =
  "BT /F1 24 Tf 72 720 Td (HAGQ Ilbdft egjmnpqy) Tj 0 -38 Td (ABCXYZ abcxyz gpqy JQ) Tj 0 -38 Td (Ascenders BDFHKL and descenders gjpqy) Tj ET";
const pdf = join(output, "helvetica-ink.pdf");
writeFileSync(
  pdf,
  Buffer.from(
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
    "latin1",
  ),
);
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = false\nUseTabs = true\n",
);
let app: any;
try {
  app = await launchControlled(["-appdata", data, pdf]);
  await app.client.waitForRenderIdle();
  const result = await app.client.request(ControlCommand.TestNotesPerf, [
    "ink",
    1,
  ]);
  assert.equal(result[0], 0, String(result[1]));
  const raw = String(result[1]);
  const ink = Object.fromEntries(
    [...raw.matchAll(/([A-Za-z]+)=(-?\d+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  console.log(ink);
  writeFileSync(join(output, "geometry.json"), JSON.stringify(ink, null, 2));
  assert.equal(
    ink.sourceMatch,
    1,
    "accurate ink must preserve the original text byte-for-byte",
  );
  assert.equal(
    ink.inkCount,
    ink.rawCount,
    "glyph indices used by selection and note anchors must remain identical",
  );
  assert.ok(
    ink.rawCount > 60 && ink.letters > 50,
    "the real PDF must expose all known glyphs",
  );
  assert.ok(
    ink.uppercase > 15 &&
      ink.lowercase > 25 &&
      ink.descenders > 10 &&
      ink.lineBreaks >= 2,
    "the fixture covers uppercase, ascenders, descenders and multiple lines",
  );
  assert.equal(
    ink.tooTall,
    0,
    "ink boxes must never be taller than the original typographic boxes",
  );
  assert.equal(
    ink.outside,
    0,
    "ink must remain inside the original vertical bounds",
  );
  assert.ok(
    ink.tighter >= ink.letters * 0.9,
    "at least 90% of actual letter boxes must be visibly tighter",
  );
  assert.ok(
    ink.inkHeight < ink.rawHeight * 0.85,
    "combined ink height must be at least 15% tighter",
  );
  assert.ok(
    ink.maxInk - ink.minInk >= 3,
    "actual glyph ink must distinguish letter shapes rather than reuse a uniform line band",
  );
  console.log(
    "PASS: Helvetica ink bounds tighten real glyphs while preserving source text and annotation indices.",
  );
  console.log(`Artifacts: ${output}`);
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
