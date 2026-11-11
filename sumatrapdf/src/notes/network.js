import { native } from "./bridge.js";

const browserFetch = globalThis.fetch.bind(globalThis);
const pending = new Map();
const noBodyStatuses = new Set([204, 205, 304]);
let enabled = false;

function finish(entry) {
  entry.finished = true;
  pending.delete(entry.id);
  entry.signal.removeEventListener("abort", entry.onAbort);
}
function stopNative(entry) {
  return native("cancelFetch", { id: entry.id }).catch(() => {});
}
function fail(entry, reason) {
  if (entry.finished) return;
  finish(entry);
  const error =
    reason instanceof Error || reason instanceof DOMException
      ? reason
      : new TypeError(String(reason || "Network request failed"));
  entry.bodyError = error;
  try {
    entry.controller.error(error);
  } catch {}
  if (!entry.response) entry.reject(error);
}
function responseHeaders(value) {
  return new Headers(typeof value === "string" ? JSON.parse(value || "{}") : value || {});
}
function attachResponse(response, entry) {
  Object.defineProperty(response, "url", { value: entry.url });
  // Chromium otherwise turns errors from a supplied stream into "Failed to fetch".
  for (const name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const consume = response[name];
    if (typeof consume !== "function") continue;
    Object.defineProperty(response, name, {
      value: (...args) => {
        if (entry.signal.aborted)
          return Promise.reject(entry.signal.reason || new DOMException("The operation was aborted.", "AbortError"));
        return consume.apply(response, args).catch((error) => {
          throw entry.bodyError || error;
        });
      },
    });
  }
  const clone = response.clone;
  Object.defineProperty(response, "clone", { value: () => attachResponse(clone.call(response), entry) });
  return response;
}
function startResponse(entry, status, event = {}) {
  if (entry.response || entry.finished) return;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new TypeError(`Invalid HTTP status: ${status}`);
  entry.noBody = noBodyStatuses.has(status);
  const response = new Response(entry.noBody ? null : entry.stream, {
    status,
    statusText: event.statusText || "",
    headers: responseHeaders(event.headers),
  });
  entry.response = attachResponse(response, entry);
  if (entry.noBody) entry.controller.close();
  else for (const chunk of entry.queued) entry.controller.enqueue(chunk);
  entry.queued = [];
  entry.resolve(response);
}
function bytesFromBase64(value) {
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function receive(event) {
  const data = event.detail || {},
    entry = pending.get(data.id);
  if (!entry || entry.finished) return;
  try {
    if (data.error != null) {
      fail(entry, data.error);
      return;
    }
    if (data.status != null) startResponse(entry, Number(data.status), data);
    if (data.chunk != null) {
      const bytes = bytesFromBase64(data.chunk);
      if (!entry.response) entry.queued.push(bytes);
      else if (!entry.noBody && bytes.length) entry.controller.enqueue(bytes);
    }
    if (data.done) {
      if (!entry.response) startResponse(entry, 200, data);
      if (!entry.noBody) entry.controller.close();
      finish(entry);
    }
  } catch (err) {
    fail(entry, err);
    stopNative(entry);
  }
}

async function nativeFetch(input, init) {
  const request = new Request(input, init),
    url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) return browserFetch(input, init);
  const signal = request.signal;
  if (signal.aborted) throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
  const body = request.body ? await request.text() : "";
  if (signal.aborted) throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
  return new Promise((resolve, reject) => {
    const entry = {
      id: crypto.randomUUID(),
      url: request.url,
      signal,
      resolve,
      reject,
      response: null,
      finished: false,
      queued: [],
    };
    entry.stream = new ReadableStream({
      start(controller) {
        entry.controller = controller;
      },
      cancel() {
        if (!entry.finished) {
          finish(entry);
          return stopNative(entry);
        }
      },
    });
    entry.onAbort = () => {
      fail(entry, signal.reason || new DOMException("The operation was aborted.", "AbortError"));
      stopNative(entry);
    };
    pending.set(entry.id, entry);
    signal.addEventListener("abort", entry.onAbort, { once: true });
    native("fetch", {
      id: entry.id,
      url: entry.url,
      method: request.method,
      headers: JSON.stringify(Object.fromEntries(request.headers)),
      body,
    }).then(
      (result) => {
        if (result === false) fail(entry, "Native network request could not be started");
      },
      (err) => fail(entry, err),
    );
  });
}

export function enableNativeNetwork() {
  if (enabled) return;
  enabled = true;
  window.addEventListener("netevent", receive);
  globalThis.fetch = nativeFetch;
  window.addEventListener("pagehide", () => {
    for (const entry of pending.values()) {
      fail(entry, new DOMException("The page was closed.", "AbortError"));
      stopNative(entry);
    }
  });
}
