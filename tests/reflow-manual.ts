import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv,
  pdfArg = args.indexOf("--pdf");
if (pdfArg < 0 || !args[pdfArg + 1])
  throw new Error(
    "Usage: bun tests/reflow-manual.ts --pdf <local.pdf> [--pages=337,334]",
  );
const pdf = resolve(args[pdfArg + 1]),
  requested = (
    args.find((value) => value.startsWith("--pages="))?.split("=")[1] ||
    "337,334"
  )
    .split(",")
    .map(Number);
const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `reflow-manual-${Date.now()}`),
  data = join(output, "appdata");
mkdirSync(data, { recursive: true });
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nUseTabs = true\nDefaultZoom = 100\n",
);
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId } = await import("../sumatrapdf/tests/util.ts");
const { setProcessDpiAware, captureWindowToPng } =
  await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const reserve = createServer();
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = (reserve.address() as any).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
let app: any, browser: any, flow: any;
const report: any = { pdf, output, pages: [] };
async function poll(
  read: () => Promise<any>,
  accepts: (value: any) => boolean,
  label: string,
) {
  const end = Date.now() + 60000;
  let last;
  while (Date.now() < end) {
    try {
      last = await read();
      if (accepts(last)) return last;
    } catch (error) {
      last = String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
async function call(action: string, fields: any = {}) {
  return await flow.evaluate(
    ({ action, fields }: any) =>
      (window as any).__sumatra__.call(
        "reflow",
        JSON.stringify({ action, ...fields }),
      ),
    { action, fields },
  );
}
async function settle() {
  await flow.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
try {
  app = await launchControlled(
    [
      "-appdata",
      data,
      "-log-to-file",
      join(output, "native.log"),
      "-page",
      String(requested[0]),
      "-window-pos",
      "1400x950@80x50",
      pdf,
    ],
    {
      saveSettings: true,
      env: {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
    },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  browser = await poll(
    () => chromium.connectOverCDP(`http://127.0.0.1:${port}`),
    Boolean,
    "CDP",
  );
  flow = await poll(
    async () =>
      browser
        .contexts()
        .flatMap((context: any) => context.pages())
        .find((page: any) => page.url().includes("sumatra-reflow/reflow.html")),
    Boolean,
    "reflow host",
  );
  for (const number of requested) {
    report.step = `actual page ${number}`;
    console.log(`[reflow-manual] ${report.step}`);
    if ((await app.client.chapterInfo()).page !== number)
      await app.client.goToLocation(1, number);
    await flow.waitForFunction(
      (number: number) =>
        document
          .querySelector("#page-label")
          ?.textContent?.startsWith(`${number} /`) &&
        !!document.querySelector(
          `.source-page[data-page="${number}"] .page-content`,
        ),
      number,
      { timeout: 60000 },
    );
    const page: any = await call("page", { page: number });
    assert.equal(page.error, "");
    writeFileSync(join(output, `page${number}.xhtml`), page.html);
    writeFileSync(join(output, `page${number}-source.txt`), page.sourceText);
    if (page.displayText)
      writeFileSync(
        join(output, `page${number}-display.txt`),
        page.displayText,
      );
    const source = Array.from(page.sourceText),
      display = Array.from(page.displayText || page.sourceText);
    assert.equal(display.length, source.length);
    let corrected = 0;
    for (let i = 0; i < source.length; i++)
      if (source[i] !== display[i]) {
        assert.equal(source[i], "\uFFFD");
        assert.equal(display[i], " ");
        corrected++;
      }
    const result: any = {
      page: number,
      sourceFFFD: source.filter((char) => char === "\uFFFD").length,
      displayFFFD: display.filter((char) => char === "\uFFFD").length,
      corrected,
      codepoints: source.length,
    };
    report.pages.push(result);
    assert.ok(
      corrected > 0,
      "this actual broken-font page must have geometry-confirmed blank corrections",
    );
    if (number === 337)
      assert.ok(
        corrected > 100,
        "manual337 must correct the observed >100 blank replacement glyphs",
      );
    const ui = await flow.evaluate(
      async ({ number, sourceText, displayText }: any) => {
        const content = document.querySelector(
          `.source-page[data-page="${number}"] .page-content`,
        )!;
        const moduleUrl = new URL("reflow-model.js", location.href).href;
        const { SourcePage } = await import(moduleUrl);
        const model = new SourcePage(content, number, sourceText, displayText),
          walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        let chosen: any;
        for (let node; (node = walker.nextNode());) {
          const text = node.textContent || "";
          for (const match of text.matchAll(/[A-Za-z]{6,}/g)) {
            if (number === 337 && match[0] !== "Timestamp") continue;
            const range = document.createRange();
            range.setStart(node, match.index!);
            range.setEnd(node, match.index! + match[0].length);
            try {
              const ranges = model.selection(range);
              if (
                ranges.length &&
                Array.from(sourceText)
                  .slice(0, ranges[0].start)
                  .includes("\uFFFD")
              ) {
                chosen = { word: match[0], ranges };
                (window as any).manualReadingRange = range;
                break;
              }
            } catch {}
          }
          if (chosen) break;
        }
        if (!chosen)
          throw new Error("No reliable source word in actual normalized XHTML");
        const boxes = [...content.querySelectorAll<HTMLTableElement>("table")];
        return {
          fffd: (content.textContent?.match(/\uFFFD/g) || []).length,
          tables: boxes.length,
          rows: boxes.reduce((n, table) => n + table.rows.length, 0),
          cells: content.querySelectorAll("td,th").length,
          description: (content.textContent?.match(/Description/g) || [])
            .length,
          ...chosen,
        };
      },
      { number, sourceText: page.sourceText, displayText: page.displayText },
    );
    result.ui = ui;
    if (number === 334 && args.includes("--reading-order")) {
      result.readingOrder = await flow.evaluate(() => {
        const content = document.querySelector(
          '.source-page[data-page="334"] .page-content',
        )!;
        const text = content.textContent!.replace(/\s+/g, " ");
        return [
          "5.2 RISC-V E902 Subsystem",
          "5.2.1 Overview",
          "The RISC-V system includes",
          "The RISC-V system has the following features:",
          "5.2.2 Block Diagram",
          "5.2.3 Register List",
        ].map((marker) => ({ marker, offset: text.indexOf(marker) }));
      });
      for (let i = 0; i < result.readingOrder.length; i++) {
        const item = result.readingOrder[i];
        assert.ok(
          item.offset >= 0,
          `missing source heading/body: ${item.marker}`,
        );
        if (i > 0)
          assert.ok(
            item.offset > result.readingOrder[i - 1].offset,
            `source headings and body must stay in reading order: ${JSON.stringify(result.readingOrder)}`,
          );
      }
    }
    if (args.includes("--no-watermark")) {
      result.watermarkImages = await flow.evaluate(async (number: number) => {
        const content = document.querySelector(
          `.source-page[data-page="${number}"] .page-content`,
        )!;
        const images = [...content.querySelectorAll("img")];
        await Promise.all(images.map((image) => image.decode()));
        return images.filter(
          (image) => image.naturalWidth === 650 && image.naturalHeight === 486,
        ).length;
      }, number);
      assert.equal(
        result.watermarkImages,
        0,
        "the manual's background watermark must not become a standalone image",
      );
    }
    if (number === 334 && args.includes("--vector-diagram")) {
      result.diagram = await flow.evaluate(async () => {
        const content = document.querySelector(
          '.source-page[data-page="334"] .page-content',
        )!;
        const headings = [...content.querySelectorAll("h1,h2,h3,h4,h5,h6,p")];
        const heading = headings.find((element) =>
          /5\.2\.2\s+Block\s+Diagram/.test(element.textContent || ""),
        );
        const next = headings.find((element) =>
          /5\.2\.3\s+Register\s+List/.test(element.textContent || ""),
        );
        if (!heading || !next)
          throw Error("Actual Block Diagram section headings are missing");
        const images = [...content.querySelectorAll("img")].filter(
          (image) =>
            !!(
              heading.compareDocumentPosition(image) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ) &&
            !!(
              image.compareDocumentPosition(next) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        );
        for (const image of images) {
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let blue = 0,
            yellow = 0,
            green = 0,
            black = 0,
            gray = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i],
              g = pixels[i + 1],
              b = pixels[i + 2];
            if (r > 120 && r < 180 && g > 175 && g < 225 && b > 235) blue++;
            if (r > 235 && g > 205 && g < 245 && b > 125 && b < 190) yellow++;
            if (r > 185 && r < 230 && g > 205 && g < 240 && b > 160 && b < 210)
              green++;
            if (r < 65 && g < 65 && b < 65) black++;
            if (
              r >= 144 &&
              r <= 220 &&
              Math.max(r, g, b) - Math.min(r, g, b) <= 3
            )
              gray++;
          }
          if (blue > 100 && yellow > 100 && green > 100 && black > 100) {
            (window as any).manualDiagram = image;
            return {
              width: canvas.width,
              height: canvas.height,
              blue,
              yellow,
              green,
              black,
              grayFraction: gray / (canvas.width * canvas.height),
            };
          }
        }
        return null;
      });
      assert.ok(
        result.diagram,
        "5.2.2 must contain the actual rendered vector Block Diagram after reflow",
      );
      for (const color of ["blue", "yellow", "green", "black"])
        assert.ok(
          result.diagram[color] > 100,
          `Block Diagram must retain its ${color} nodes/text/arrows`,
        );
      if (args.includes("--no-watermark"))
        assert.ok(
          result.diagram.grayFraction < 0.02,
          "the cropped Block Diagram must omit the gray background watermark",
        );
      result.diagramZoom = [];
      for (const zoom of [200, 400]) {
        sendCommandSync(app.frame, cmdId(`CmdZoom${zoom}`));
        await flow.waitForFunction(
          (zoom: number) =>
            document
              .querySelector("#page-label")
              ?.textContent?.includes(`${zoom}%`),
          zoom,
        );
        const bounds = await flow.evaluate(() => {
          const image = (window as any).manualDiagram as HTMLImageElement;
          image.scrollIntoView({ block: "center" });
          const rect = image.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            available: image.closest(".page-content")!.clientWidth,
            ratio: image.naturalWidth / image.naturalHeight,
            documentWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        assert.ok(bounds.width <= bounds.available + 1);
        assert.ok(bounds.scrollWidth <= bounds.documentWidth + 1);
        assert.ok(Math.abs(bounds.width / bounds.height - bounds.ratio) < 0.01);
        result.diagramZoom.push({ zoom, ...bounds });
        await captureWindowToPng(
          app.frame,
          join(output, `diagram-${zoom}.png`),
        );
      }
    }
    assert.equal(
      ui.fffd,
      result.displayFFFD,
      "normalized actual page must not display replacement boxes for blank glyphs",
    );
    assert.equal(
      ui.ranges
        .map((range: any) => display.slice(range.start, range.end).join(""))
        .join(""),
      ui.word,
      "source anchors must still index the exact original codepoint positions",
    );
    if (number === 337) {
      assert.equal(ui.tables, 5);
      assert.equal(ui.cells, 79);
      assert.equal(ui.description, 4);
    }
    sendCommandSync(app.frame, cmdId("CmdZoom100"));
    await flow.waitForFunction(() =>
      document.querySelector("#page-label")?.textContent?.includes("100%"),
    );
    const before = await flow.evaluate(() => {
      const range = (window as any).manualReadingRange as Range;
      scrollBy(0, range.getBoundingClientRect().top - 150);
      return range.getBoundingClientRect().top;
    });
    await settle();
    sendCommandSync(app.frame, cmdId("CmdZoomIn"));
    await flow.waitForFunction(() =>
      document.querySelector("#page-label")?.textContent?.includes("110%"),
    );
    await settle();
    const after = await flow.evaluate(() => ({
      top: ((window as any).manualReadingRange as Range).getBoundingClientRect()
        .top,
      label: document.querySelector("#page-label")?.textContent,
      scrollWidth: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    result.zoom = { before, ...after };
    assert.ok(
      Math.abs(after.top - before) <= 32,
      "zoom must keep the visible actual-manual glyph near its reading position",
    );
    assert.ok(after.scrollWidth <= after.width + 1);
    await captureWindowToPng(app.frame, join(output, `manual-${number}.png`));
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(
      `[reflow-manual] page ${number}: ${result.sourceFFFD} raw FFFD → ${result.displayFFFD} display; ${corrected} confirmed blanks; glyph delta ${(after.top - before).toFixed(2)}px`,
    );
  }
  console.log(
    `PASS: actual PDF blank-glyph normalization, unchanged original source anchors, table structure and stable visible-glyph zoom. Artifacts: ${output}`,
  );
} catch (error) {
  report.error = String((error as Error).stack || error);
  if (flow && !flow.isClosed()) {
    try {
      report.failure = await flow.evaluate(() => ({
        label: document.querySelector("#page-label")?.textContent,
        status: document.querySelector("#status")?.textContent,
        sections: [
          ...document.querySelectorAll<HTMLElement>(".source-page"),
        ].map((section) => ({
          page: section.dataset.page,
          top: section.getBoundingClientRect().top,
        })),
      }));
      await flow.screenshot({ path: join(output, "failure.png") });
    } catch {}
  }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
  if (browser) await browser.close().catch(() => {});
}
