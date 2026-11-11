// Read-aloud for the side panel's speaker button, in American English with a young, bright female
// voice. First choice is the bundled Kokoro neural voice (tts-worker.js, files in vendor/kokoro);
// when that isn't installed or fails to load, the browser's own en-US voice is used instead.

const NEURAL_VOICE = 'af_bella'; // Kokoro's young, energetic US female voice (others in vendor/kokoro/voices)
const NEURAL_SPEED = 0.8; // 1 = normal
const IDLE_UNLOAD_MS = 5 * 60 * 1000; // free the model's memory after 5 idle minutes
const CLIP_CACHE = 40;

// ---------------------------------------------------------------- neural voice (worker)

let worker = null;
let ready = false; // the model loaded at least once, so later errors are about the text, not the setup
let broken = false; // the bundle is missing or can't run here: use the system voice from now on
let seq = 0;
let idleTimer = null;
const pending = new Map(); // request id -> { resolve, reject }
const clips = new Map(); // text -> { audio, rate }, least recently used first

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function unload() {
  worker?.terminate();
  worker = null;
  failAll('unloaded');
}

function getWorker() {
  if (broken) return null;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_UNLOAD_MS);
  if (worker) return worker;
  worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (!data.error) ready = true;
    else if (!ready) {
      broken = true;
      console.warn('Kokoro voice unavailable, using the system voice:', data.error);
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data);
  };
  // A module that fails to load (vendor/kokoro not installed) only shows up here.
  worker.onerror = (e) => {
    e.preventDefault();
    broken = true;
    console.warn('Kokoro voice unavailable, using the system voice:', e.message || 'worker failed to start');
    unload();
  };
  return worker;
}

function request(msg) {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('unavailable'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
}

/** Start loading the model ahead of the first click (called when the pointer enters a card). */
export function warmUp() {
  if (broken || worker) return;
  request({}).catch(() => {});
}

/** Start synthesizing `text` before the click (called when the pointer reaches its speaker button). */
export function prefetch(text) {
  const clean = tidy(text);
  if (clean && !broken) neuralClip(clean).catch(() => {});
}

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// A bare word read without end punctuation tends to trail off; a full stop gives it a clean ending.
const forSpeech = (text) => (/[.!?…]["')\]]*$/.test(text) ? text : `${text}.`);

// Kokoro pads each clip with ~0.4 s of silence in front and ~0.65 s behind: cut it down so the word
// starts right after the click. Then lift quiet clips to a fixed peak so every word comes out
// equally loud and clear.
function shape(audio, rate) {
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  if (!peak) return audio;
  const quiet = peak * 0.01;
  let start = 0;
  while (start < audio.length && Math.abs(audio[start]) < quiet) start++;
  let end = audio.length;
  while (end > start && Math.abs(audio[end - 1]) < quiet) end--;
  const out = audio.slice(Math.max(0, start - Math.round(rate * 0.05)), Math.min(audio.length, end + Math.round(rate * 0.12)));
  const gain = Math.min(0.95 / peak, 4);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

// Clips are cached as promises, so a click during a hover-started synthesis waits for that one.
function neuralClip(text) {
  const key = `${NEURAL_VOICE}|${NEURAL_SPEED}|${text}`;
  const hit = clips.get(key);
  if (hit) {
    clips.delete(key);
    clips.set(key, hit);
    if (worker) getWorker(); // push back the idle unload while it's being used
    return hit;
  }
  if (broken) return Promise.resolve(null);
  const clip = request({ text: forSpeech(text), voice: NEURAL_VOICE, speed: NEURAL_SPEED })
    .then((data) => ({ audio: shape(data.audio, data.rate), rate: data.rate }));
  clip.catch(() => clips.get(key) === clip && clips.delete(key));
  clips.set(key, clip);
  if (clips.size > CLIP_CACHE) clips.delete(clips.keys().next().value);
  return clip;
}

// ---------------------------------------------------------------- playback

let ctx = null;

function playClip(clip, job) {
  const buf = ctx.createBuffer(1, clip.audio.length, clip.rate);
  buf.copyToChannel(clip.audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  return new Promise((resolve) => {
    src.onended = resolve;
    job.stop = () => {
      src.onended = null;
      try {
        src.stop();
      } catch {}
      resolve();
    };
    src.start();
  });
}

// ---------------------------------------------------------------- system voice (fallback)

// The Web Speech API doesn't report gender, so voices are matched by name, best first: neural
// voices, then the crisp local ones (Zira on Windows, Samantha on macOS), then Google's online
// voice, which needs Google's servers and may be unreachable.
const FEMALE_VOICES = [
  /\bAria\b/, /\bJenny\b/, /\bAva\b/, /\bEmma\b/, /\bMichelle\b/, /\bAna\b/,
  /\bZira\b/, /\bSamantha\b/, /\bAllison\b/, /\bSusan\b/, /\bVictoria\b/, /\bZoe\b/, /\bNicky\b/,
  /Google US English/,
];
const SYSTEM_RATE = 0.75;
const hasSystemVoice = typeof speechSynthesis !== 'undefined';

const usVoices = () => speechSynthesis.getVoices().filter((v) => /^en[-_]US$/i.test(v.lang));

function pickVoice() {
  const voices = usVoices();
  for (const re of FEMALE_VOICES) {
    const v = voices.find((x) => re.test(x.name) && x.localService) || voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices.find((v) => /female/i.test(v.name)) || voices.find((v) => v.localService) || voices[0] || null;
}

// Chrome fills the voice list asynchronously; speaking before it arrives would use the default
// (male) voice, so wait for it briefly.
function voicesReady() {
  if (usVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      speechSynthesis.removeEventListener('voiceschanged', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    speechSynthesis.addEventListener('voiceschanged', finish);
  });
}

async function systemSpeak(text, job) {
  if (!hasSystemVoice) return;
  await voicesReady();
  if (job.stopped) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = SYSTEM_RATE;
  const voice = pickVoice();
  if (voice) u.voice = voice;
  await new Promise((resolve) => {
    u.onend = resolve;
    u.onerror = resolve;
    job.stop = () => {
      speechSynthesis.cancel();
      resolve();
    };
    speechSynthesis.speak(u);
  });
}
if (hasSystemVoice) speechSynthesis.getVoices(); // start loading the voice list early

// ---------------------------------------------------------------- public

let active = null; // { btn, stopped, stop }

function finish(job) {
  if (!job || job.stopped) return;
  job.stopped = true;
  job.stop?.();
  job.btn?.classList.remove('on');
  if (active === job) active = null;
}

export const canSpeak = () => typeof Worker !== 'undefined' || hasSystemVoice;

/** Read `text` aloud; `btn` shows the "on" state until it finishes. A new call cuts off the previous one. */
export async function speak(text, btn) {
  const clean = tidy(text);
  if (!clean) return;
  finish(active);
  const job = { btn, stopped: false, stop: null };
  active = job;
  btn?.classList.add('on');
  // Created inside the click so the browser lets it make sound.
  ctx ||= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  try {
    let clip = null;
    try {
      clip = await neuralClip(clean);
    } catch (err) {
      if (err.message !== 'unloaded') console.warn('Kokoro voice failed, using the system voice:', err.message);
    }
    if (job.stopped) return;
    if (clip) await playClip(clip, job);
    else await systemSpeak(clean, job);
  } finally {
    finish(job);
  }
}
