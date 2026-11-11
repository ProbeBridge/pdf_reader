// Read-aloud voice: Kokoro-82M (fp16) running on ONNX Runtime wasm, entirely from the files bundled
// in vendor/kokoro (see scripts/vendor-kokoro.mjs). Runs in a worker so loading the model and
// synthesizing don't freeze the side panel.
//
// in:  { id, text, voice, speed }   (no text: just load the model)
// out: { id, audio: Float32Array, rate } | { id, ready: true } | { id, error }
import { env } from '../vendor/kokoro/transformers.min.js';
import { KokoroTTS } from '../vendor/kokoro/kokoro.js';

const base = new URL('../vendor/kokoro/', import.meta.url).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = base;
env.useBrowserCache = false; // the files are already local; Cache Storage can't hold chrome-extension:// URLs
env.backends.onnx.wasm.wasmPaths = `${base}ort/`;
// Threads need SharedArrayBuffer, i.e. cross-origin isolation (set for extension pages in the
// manifest). Measured on a 6-core PC: 4 threads ≈ 1.6 s per word, 1 thread ≈ 4 s; more than 4 is slower.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1)) : 1;

// fp16 runs about as fast as fp32 on wasm at half the download; q8 is half the size again but
// twice as slow; WebGPU measured slower than wasm for this model.
let model = null;
const load = () => (model ||= KokoroTTS.from_pretrained('model', { dtype: 'fp16', device: 'wasm' }).catch((err) => {
  model = null;
  throw err;
}));

// One synthesis at a time: the session isn't meant for overlapping runs.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  const { id, text, voice, speed } = data;
  queue = queue.then(async () => {
    try {
      const tts = await load();
      if (!text) return self.postMessage({ id, ready: true });
      const out = await tts.generate(text, { voice, speed });
      self.postMessage({ id, audio: out.audio, rate: out.sampling_rate }, [out.audio.buffer]);
    } catch (err) {
      self.postMessage({ id, error: String(err?.message || err) });
    }
  });
};
