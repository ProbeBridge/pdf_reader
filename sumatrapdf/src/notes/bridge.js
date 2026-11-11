const listeners = new Set();
export const zh = navigator.language.toLowerCase().startsWith("zh");
export const text = (cn, en) => (zh ? cn : en);
export async function native(action, args = {}) {
  if (!window.__sumatra__) throw new Error("SumatraPDF bridge is unavailable");
  return window.__sumatra__.call("notes", JSON.stringify({ action, ...args }));
}
const locale = await fetch(`./_locales/${zh ? "zh_CN" : "en"}/messages.json`).then((r) => r.json());
Object.assign((globalThis.chrome ||= {}), {
  i18n: {
    getUILanguage: () => navigator.language,
    getMessage(key, subs = []) {
      return (locale[key]?.message || key).replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? "");
    },
  },
  storage: {
    local: {
      async get(keys = null) {
        const all = await native("read");
        if (keys === null) return all;
        const defaults = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(list.map((k) => [k, all[k] ?? defaults[k]]));
      },
      async set(patch) {
        for (const [key, value] of Object.entries(patch)) await native("write", { key, value: JSON.stringify(value) });
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) await native("remove", { key });
      },
    },
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  },
});
window.addEventListener("storechange", (e) => listeners.forEach((fn) => fn(e.detail, "local")));
export function node(tag, cls, content) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (content != null) el.textContent = content;
  return el;
}
export function button(label, fn, cls = "") {
  const b = node("button", cls, label);
  b.type = "button";
  b.addEventListener("click", () => Promise.resolve().then(fn).catch(showError));
  return b;
}
export function showError(err) {
  toast(String(err?.message || err));
}
let toastTimer;
export function toast(message, undo, actionLabel = text("撤销", "Undo")) {
  clearTimeout(toastTimer);
  const box = document.getElementById("toast");
  box.replaceChildren(node("span", "", message));
  if (undo)
    box.append(
      button(actionLabel, async () => {
        await undo();
        box.hidden = true;
      }),
    );
  box.hidden = false;
  toastTimer = setTimeout(() => (box.hidden = true), 6000);
}
