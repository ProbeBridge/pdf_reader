import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `page-background-${Date.now()}`);
mkdirSync(output, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf/out/rel64/SumatraPDF.exe",
);
const { launchControlled, killAndWait, findCanvas, sendCommandSync } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { captureWindowPixels, captureWindowToPng, setProcessDpiAware } =
  await import("../sumatrapdf/tests/winapi.ts");
const { makeZip, makePng, cmdId } = await import("../sumatrapdf/tests/util.ts");
setProcessDpiAware();
const epub = join(output, "paper.epub");
const enc = (value: string) => Buffer.from(value);
writeFileSync(
  epub,
  makeZip([
    { name: "mimetype", data: enc("application/epub+zip"), store: true },
    {
      name: "META-INF/container.xml",
      data: enc(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    },
    {
      name: "book.opf",
      data: enc(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">paper-fixture</dc:identifier><dc:title>Original colors</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="p" href="pink.png" media-type="image/png"/><item id="w" href="white.png" media-type="image/png"/></manifest><spine><itemref idref="c"/></spine></package>',
      ),
    },
    {
      name: "chapter.xhtml",
      data: enc(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Paper</title><style>html,body { background:white; } body { margin:18px; font-family:serif; font-size:20px; } h1 {color:#cc0000;} p {color:#0000cc;} .box {width:100px;height:40px;background:#336699;}</style></head><body><h1>Keep the original heading</h1><p>Keep the original blue text and line wrapping.</p><img src="pink.png" width="90" height="90"/><img src="white.png" width="90" height="90"/><div class="box"></div></body></html>',
      ),
    },
    { name: "pink.png", data: makePng(90, 90, [237, 61, 102]), store: true },
    { name: "white.png", data: makePng(90, 90, [255, 255, 255]), store: true },
  ]),
);

const pdf = join(output, "paper.pdf");
const content =
  "1 1 1 rg 0 0 420 595 re f\nBT /F1 24 Tf 0.8 0 0 rg 24 540 Td (Keep original heading) Tj ET\nBT /F1 15 Tf 0 0 0.8 rg 24 495 Td (Keep original blue text.) Tj ET\n0.2 0.4 0.6 rg 24 270 100 40 re f\nq 90 0 0 90 24 360 cm /Pink Do Q\nq 90 0 0 90 114 360 cm /White Do Q\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 4 0 R >> /XObject << /Pink 6 0 R /White 7 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n" +
    String.fromCharCode(237, 61, 102) +
    "\nendstream",
  "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n" +
    String.fromCharCode(255, 255, 255) +
    "\nendstream",
];
let pdfText = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(pdfText.length);
  pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = pdfText.length;
pdfText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdfText += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join("");
pdfText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(pdf, Buffer.from(pdfText, "latin1"));

function colorPixels(capture: any, rgb: number[]) {
  const pixels: number[] = [];
  for (let i = 0; i < capture.data.length; i += 4)
    if (
      capture.data[i] === rgb[2] &&
      capture.data[i + 1] === rgb[1] &&
      capture.data[i + 2] === rgb[0]
    )
      pixels.push(i / 4);
  return pixels;
}
async function render(file: string, tinted: boolean) {
  const label = file.endsWith(".epub") ? "epub" : "pdf",
    data = join(output, `${label}-${tinted ? "green" : "original"}`);
  mkdirSync(data);
  writeFileSync(
    join(data, "SumatraPDF-settings.txt"),
    `RestoreSession = false\nCheckForUpdates = false\nReuseInstance = false\nTheme = Light\nDocumentColorsFollowTheme = off\nShowToc = false\nShowStartPage = false\nEBookUI [\n  FontSize = 12\n]\nFileStates [\n  [\n    FilePath = ${file}\n    PageBackgroundColor = ${tinted ? "#c7edcc" : ""}\n  ]\n]\n`,
  );
  const app = await launchControlled([
    "-appdata",
    data,
    "-view",
    "single page",
    "-zoom",
    "100",
    "-window-pos",
    "1040x820@60x60",
    file,
  ]);
  try {
    await app.client.setNotificationsEnabled(false);
    await app.client.waitForRenderIdle();
    const canvas = findCanvas(app.frame);
    let capture: any;
    for (let i = 0; i < 50; i++) {
      capture = captureWindowPixels(canvas);
      if (capture && colorPixels(capture, [237, 61, 102]).length > 1000) break;
      await Bun.sleep(100);
    }
    assert.ok(capture);
    await captureWindowToPng(
      app.frame,
      join(output, `${label}-${tinted ? "green" : "original"}.png`),
    );
    return { capture, chapter: await app.client.chapterInfo() };
  } finally {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
for (const file of [epub, pdf]) {
  const original = await render(file, false),
    tinted = await render(file, true),
    green = colorPixels(tinted.capture, [199, 237, 204]).length;
  assert.ok(
    green > 100000,
    `${file}: page paper must become green (found ${green} pixels)`,
  );
  assert.deepEqual(
    tinted.chapter,
    original.chapter,
    "background does not repaginate the document",
  );
  for (const rgb of [
    [237, 61, 102],
    [204, 0, 0],
    [0, 0, 204],
    [51, 102, 153],
  ]) {
    const before = colorPixels(original.capture, rgb);
    assert.ok(before.length > 50, `fixture contains ${rgb}`);
    const after = colorPixels(tinted.capture, rgb);
    if (rgb[0] === 237 || rgb[0] === 51) {
      assert.deepEqual(
        after,
        before,
        `original image/box pixels and positions stay identical: ${rgb}`,
      );
    } else {
      const source = new Set(before),
        target = new Set(after),
        width = original.capture.w;
      const opaque = before.filter((pixel) =>
        [pixel - 1, pixel + 1, pixel - width, pixel + width].every((neighbor) =>
          source.has(neighbor),
        ),
      );
      assert.ok(opaque.length > 50);
      assert.ok(
        opaque.every((pixel) => target.has(pixel)),
        `opaque glyph colors and positions stay identical: ${rgb}`,
      );
      assert.ok(
        Math.abs(after.length - before.length) < before.length * 0.015,
        "only antialiasing at the new paper color may differ",
      );
    }
  }
  const pink = colorPixels(original.capture, [237, 61, 102]),
    white = colorPixels(tinted.capture, [255, 255, 255]);
  assert.ok(
    white.length >= pink.length * 0.95,
    "the opaque white image stays white",
  );
  assert.ok(
    white.length <= pink.length * 1.2,
    "the page must not retain a white body behind the original text",
  );
  console.log(
    `PASS: ${file.endsWith(".epub") ? "EPUB" : "PDF"} paper-only background, exact original image/text/box pixels, layout and white image preserved.`,
  );
}
const savedData = join(output, "pdf-green");
const restoredApp = await launchControlled(
  [
    "-appdata",
    savedData,
    "-view",
    "single page",
    "-zoom",
    "100",
    "-window-pos",
    "1040x820@60x60",
    pdf,
  ],
  { saveSettings: true },
);
try {
  await restoredApp.client.setNotificationsEnabled(false);
  await restoredApp.client.waitForRenderIdle();
  sendCommandSync(restoredApp.frame, cmdId("CmdRestorePageBackground"));
  await restoredApp.client.waitForRenderIdle();
  const canvas = findCanvas(restoredApp.frame);
  let white = 0,
    green = 0;
  for (let i = 0; i < 50; i++) {
    const capture = captureWindowPixels(canvas);
    if (capture) {
      white = colorPixels(capture, [255, 255, 255]).length;
      green = colorPixels(capture, [199, 237, 204]).length;
      if (white > 100000 && green === 0) break;
    }
    await Bun.sleep(100);
  }
  assert.ok(
    white > 100000 && green === 0,
    "restore command immediately restores original page paper",
  );
} finally {
  await restoredApp.client.quit().catch(() => {});
  restoredApp.client.close();
  await Promise.race([restoredApp.proc.exited, Bun.sleep(8000)]);
  if (restoredApp.proc.exitCode === null) await killAndWait(restoredApp.proc);
}
assert.doesNotMatch(
  readFileSync(join(savedData, "SumatraPDF-settings.txt"), "utf8"),
  /PageBackgroundColor\s*=\s*#c7edcc/i,
  "restoring the original paper is persisted",
);
console.log(
  "PASS: live restore clears rendered tint and the saved per-book override.",
);
console.log(`Artifacts: ${output}`);
