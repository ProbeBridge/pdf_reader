import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `no-home-covers-${Date.now()}`);
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
const { makeTextPdf } = await import("../sumatrapdf/tests/util.ts");
const { sendCopyDataW, setProcessDpiAware } =
  await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const data = join(output, "appdata");
const files = join(output, "documents");
mkdirSync(data);
mkdirSync(files);
const paths = [];
for (let index = 0; index < 64; index++) {
  const path = join(files, `history-${index}.pdf`);
  writeFileSync(path, makeTextPdf(`History fixture ${index}.`));
  paths.push(path);
}
const missingPath = join(files, "unavailable-history.pdf");
const states = [missingPath, ...paths]
  .map(
    (path) =>
      `  [\n    FilePath = ${path}\n    OpenCount = 1\n    PageNo = 1\n  ]`,
  )
  .join("\n");
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = true\nUseTabs = true\nShowStartPage = true\n" +
    `FileStates [\n${states}\n]\n`,
);
const log = join(output, "sumlog.txt");
const covers = () => {
  const cache = join(data, "sumatrapdfcache");
  return existsSync(cache)
    ? readdirSync(cache).filter((name) => name.endsWith(".png"))
    : [];
};
let app: any;
let homeLog = "",
  finalLog = "",
  homeCovers = 0,
  documentCovers = 0;
try {
  // SaveSettings deliberately omits -for-testing: that flag skips the original batch itself.
  app = await launchControlled(["-appdata", data, "-log-to-file", log], {
    saveSettings: true,
  });
  await app.client.waitForHomePainted();
  await Bun.sleep(1500);
  homeLog = readFileSync(log, "utf8");
  homeCovers = covers().length;
  assert.ok(
    sendCopyDataW(app.frame, 0x44646557, `[Open("${paths[0]}", 0, 1, 0)]`),
  );
  await app.client.waitForRenderIdle();
  await Bun.sleep(500);
  documentCovers = covers().length;
  finalLog = readFileSync(log, "utf8");
} finally {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
}
console.log(`Artifacts: ${output}`);
const preferences = readFileSync(join(data, "SumatraPDF-settings.txt"), "utf8");
const index = preferences.indexOf(`FilePath = ${missingPath}`);
assert.ok(index >= 0, "an unavailable historical file must remain in history");
const next = preferences.indexOf("FilePath = ", index + 1);
const missingRecord = preferences.slice(
  index,
  next < 0 ? preferences.length : next,
);
const hidden = /^\s*IsMissing\s*=\s*true\s*$/m.test(missingRecord);
console.log({ unavailableHistoryHidden: hidden, homeCovers, documentCovers });
assert.equal(
  hidden,
  false,
  "opening history must not hide unavailable historical paths",
);
assert.doesNotMatch(
  homeLog,
  /RemoveNonExistentFilesAsync:/,
  "the WebView history must not start native missing-file filtering",
);
assert.doesNotMatch(homeLog, /RegenerateThumbnailsThread:|ThumbnailProgress/);
assert.doesNotMatch(
  homeLog,
  /EngineMupdf::Load:/,
  "opening history must not open its documents",
);
assert.equal(homeCovers, 0, "the text history must not create native covers");
assert.equal(
  documentCovers,
  0,
  "opening one document must not create an unused home cover",
);
for (const path of paths.slice(1))
  assert.equal(
    finalLog.includes(`EngineMupdf::Load: '${path}'`),
    false,
    "other history documents must stay unopened",
  );
assert.doesNotMatch(finalLog, /RegenerateThumbnailsThread:|ThumbnailProgress/);
console.log(
  "PASS: 64 uncached history documents cause no cover work; unavailable historical paths stay searchable; explicit open loads only that file.",
);
