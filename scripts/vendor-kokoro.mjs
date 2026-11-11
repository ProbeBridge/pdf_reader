// Adapted from chrome_notes_ex 4b12e8d. All runtime files stay local after bundling.
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Use Node.js 24 or newer to vendor Kokoro.");
const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (proxy && !process.env.NODE_USE_ENV_PROXY) {
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(result.status ?? 1);
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const ONNX_RUNTIME_COMMIT = "89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0";
const ONNX_LICENSE_SHA256 =
  "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c";
const MODEL_FILES = {
  "config.json": [
    44,
    "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  ],
  "tokenizer.json": [
    3497,
    "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  ],
  "tokenizer_config.json": [
    113,
    "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  ],
  "onnx/model_fp16.onnx": [
    163234740,
    "ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a",
  ],
};
const HF_HOST = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(
  /\/$/,
  "",
);
const mod = (name) => resolve(ROOT, "node_modules", name);
const dest = resolve(ROOT, "sumatrapdf/src/notes/vendor/kokoro");
const version = async (name) =>
  JSON.parse(await readFile(resolve(mod(name), "package.json"), "utf8"))
    .version;

function patch(src, from, to) {
  const count = src.split(from).length - 1;
  if (count !== 1)
    throw new Error(`kokoro.js patch expected one match, found ${count}`);
  return src.replace(from, () => to);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validModel(path, expected) {
  const file = await stat(path).catch(() => null);
  return file?.size === expected[0] && (await sha256(path)) === expected[1];
}

async function download(file, expected) {
  const out = resolve(dest, "model", file);
  if (await validModel(out, expected)) return console.log(`  verified ${file}`);
  await mkdir(dirname(out), { recursive: true });
  console.log(`  downloading ${file}`);
  const url = `${HF_HOST}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const temporary = `${out}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary),
    );
    if (!(await validModel(temporary, expected)))
      throw new Error(`${file}: size or SHA-256 mismatch`);
    await rename(temporary, out);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Keep this upstream license in source control so preparing a cached bundle
// does not need another network request. Normalize checkout line endings.
const onnxLicense = (
  await readFile(resolve(ROOT, "scripts/licenses/LICENSE.onnxruntime"), "utf8")
).replace(/\r\n/g, "\n");
if (
  createHash("sha256").update(onnxLicense).digest("hex") !== ONNX_LICENSE_SHA256
)
  throw new Error(
    `ONNX Runtime ${ONNX_RUNTIME_COMMIT} license SHA-256 mismatch`,
  );

await mkdir(resolve(dest, "ort"), { recursive: true });
await mkdir(resolve(dest, "voices"), { recursive: true });
let kokoro = await readFile(
  resolve(mod("kokoro-js"), "dist/kokoro.js"),
  "utf8",
);
kokoro = patch(
  kokoro,
  'from"@huggingface/transformers"',
  'from"./transformers.min.js"',
);
kokoro = patch(kokoro, 'from"phonemizer"', 'from"./phonemizer.js"');
kokoro = patch(
  kokoro,
  'import s from"path";import i from"fs/promises";',
  "const s=null,i=null;",
);
kokoro = patch(
  kokoro,
  "const a=`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`;",
  'return(await fetch(new URL(`./voices/${e}.bin`,import.meta.url))).arrayBuffer();const a="";',
);
await writeFile(resolve(dest, "kokoro.js"), kokoro);
await cp(
  resolve(mod("@huggingface/transformers"), "dist/transformers.min.js"),
  resolve(dest, "transformers.min.js"),
);
for (const file of [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await cp(
    resolve(mod("@huggingface/transformers"), "dist", file),
    resolve(dest, "ort", file),
  );
}
await cp(
  resolve(mod("phonemizer"), "dist/phonemizer.js"),
  resolve(dest, "phonemizer.js"),
);
for (const file of await readdir(resolve(mod("kokoro-js"), "voices"))) {
  if (/^af_.*\.bin$/.test(file))
    await cp(
      resolve(mod("kokoro-js"), "voices", file),
      resolve(dest, "voices", file),
    );
}

console.log(`Model ${MODEL_REPO}@${MODEL_REVISION.slice(0, 7)} (fp16):`);
for (const [file, expected] of Object.entries(MODEL_FILES))
  await download(file, expected);
for (const name of ["kokoro-js", "@huggingface/transformers", "phonemizer"]) {
  const source = resolve(mod(name), "LICENSE");
  if (await stat(source).catch(() => null)) {
    await cp(
      source,
      resolve(dest, `LICENSE.${name.replace(/\W+/g, "-").replace(/^-/, "")}`),
    );
  }
}
await writeFile(resolve(dest, "LICENSE.onnxruntime"), onnxLicense);
const versions = {
  "kokoro-js": await version("kokoro-js"),
  "@huggingface/transformers": await version("@huggingface/transformers"),
  phonemizer: await version("phonemizer"),
  "onnxruntime-web": await version("onnxruntime-web"),
  "onnxruntime-license": `microsoft/onnxruntime@${ONNX_RUNTIME_COMMIT} (MIT)`,
  model: `${MODEL_REPO}@${MODEL_REVISION} onnx/model_fp16.onnx (Apache-2.0)`,
};
await writeFile(
  resolve(dest, "VERSION"),
  `${JSON.stringify(versions, null, 2)}\n`,
);
console.log("Bundled offline Kokoro voice and dependency licenses.");
