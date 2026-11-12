// Offline build fallback; apptranslator remains the source for maintainer builds.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractStringsToTranslate } from "./trans-dl";

const sourceUrl =
  "https://raw.githubusercontent.com/sumatrapdfreader/sumatrapdf/3.6.1rel/translations/translations.txt";
const sourceHash = "9590785f29d8330af4ba5d7c26346e4ec68c4eccebe62ec2cfd158a185ca0553";
const additions: Record<string, [string, string]> = {
  "AI Notes": ["AI 注释侧栏", "AI 註釋側欄"],
  "AI Notes Settings...": ["AI 注释设置...", "AI 註釋設定..."],
  "AI Annotation": ["AI 注释", "AI 註釋"],
  "Reading History": ["阅读历史", "閱讀歷史"],
  "Reflow document text": ["正文重排", "內文重排"],
  "Reflow: On": ["重排：开", "重排：開"],
  "Reflow: Off": ["重排：关", "重排：關"],
  "Toggle Light/Dark Theme": ["切换深浅主题", "切換深淺主題"],
  "Read Aloud": ["朗读", "朗讀"],
  "Delete annotation": ["删除注释", "刪除註釋"],
  "Turn off text reflow and return to the original view": ["关闭正文重排，返回原版视图", "關閉內文重排，返回原版檢視"],
  "Reflow document text to fit the available width": ["正文随窗口宽度重排", "內文隨視窗寬度重排"],
};

export function makeLocalTranslations(source: string, strings: string[]): string {
  const entries = new Map<string, Map<string, string>>();
  let translations: Map<string, string> | undefined;
  for (const line of source.replace(/\r/g, "").split("\n").slice(2)) {
    if (line.startsWith(":")) {
      translations = new Map();
      entries.set(line.slice(1), translations);
    } else if (translations && line.includes(":")) {
      const colon = line.indexOf(":");
      translations.set(line.slice(0, colon), line.slice(colon + 1));
    }
  }
  // The runtime expects every source string to have an entry, even when a
  // newer string still falls back to English in a particular language.
  for (const string of strings) if (!entries.has(string)) entries.set(string, new Map());
  for (const [string, [cn, tw]] of Object.entries(additions)) {
    const entry = entries.get(string) || new Map();
    entry.set("cn", cn);
    entry.set("tw", tw);
    entries.set(string, entry);
  }
  const lines: string[] = [];
  for (const string of [...entries.keys()].sort()) {
    lines.push(`:${string}`);
    for (const [language, translation] of [...entries.get(string)!.entries()].sort())
      lines.push(`${language}:${translation}`);
  }
  const body = lines.join("\n") + "\n";
  return `AppTranslator: SumatraPDF\n${createHash("sha1").update(body).digest("hex")}\n${body}`;
}

if (import.meta.main) {
  const local = process.argv.indexOf("--source");
  const bytes =
    local >= 0 ? readFileSync(process.argv[local + 1]!) : Buffer.from(await (await fetch(sourceUrl)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sourceHash)
    throw new Error("Unexpected upstream catalog checksum");
  const catalog = makeLocalTranslations(bytes.toString("utf8"), extractStringsToTranslate());
  mkdirSync("translations", { recursive: true });
  writeFileSync("translations/fallback.txt", catalog);
  console.log(`Wrote bundled translation fallback (${catalog.length} characters)`);
}
