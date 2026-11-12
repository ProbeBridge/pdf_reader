import { native, node, button, text, toast, showError, zh } from "./bridge.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_FOLLOWUP_PROMPT,
  PROVIDERS,
  getSettings,
  saveSettings,
} from "./shared/settings.js";
import { generateNote, generateFollowup, testConnection } from "./shared/llm.js";
import { parseNote, noteForContext } from "./shared/note-format.js";
import { renderMarkdown } from "./shared/markdown.js";
import { speak } from "./shared/tts.js";
import { setIcon } from "./icons.js";
import { mergePage, revision } from "./note-store.js";
import { enableNativeNetwork } from "./network.js";

const $ = (selector) => document.querySelector(selector);
const pages = new Map(),
  loads = new Map(),
  jobs = new Map(),
  drafts = new Map(),
  asking = new Set(),
  expanded = new Set();
let doc = {},
  page = null,
  active = null,
  following = true,
  lastPositions = [],
  documentEpoch = 0;
let autoSpeech = null,
  annotationEpoch = 0;
function cancelAutoSpeech() {
  autoSpeech?.ctrl.abort();
  autoSpeech = null;
}
function speakNewNote(key, a) {
  const ctrl = new AbortController();
  autoSpeech = { key, id: a.id, ctrl };
  speak(a.quote, null, { signal: ctrl.signal })
    .catch(() => {})
    .finally(() => {
      if (autoSpeech?.ctrl === ctrl) autoSpeech = null;
    });
}
function speakNote(key, a, btn) {
  if (key !== doc.key) return;
  if (autoSpeech && (autoSpeech.key !== key || autoSpeech.id !== a.id)) cancelAutoSpeech();
  return speak(a.quote, btn);
}
let settings = await getSettings().catch((err) => {
  showError(err);
  return { ...DEFAULT_SETTINGS };
});
let mutation = Promise.resolve();
let lastStamp = 0;
const stamp = (...values) =>
  (lastStamp = Math.max(Date.now(), lastStamp + 1, ...values.map((v) => Number(v) + 1 || 0)));
const storeKey = (key) => `page:${key}`;
const jobKey = (key, id, turnId = "") => `${key}\0${id}\0${turnId}`;
const viewKey = (key, id) => `${key}\0${id}`;
function withLock(fn) {
  const run = mutation.then(fn, fn);
  mutation = run.catch(() => {});
  return run;
}
function recoverInterrupted(p) {
  for (const a of p.annotations) {
    if (a.status === "pending") {
      a.status = "error";
      a.error = text("上次生成被中断，请重试", "Previous request interrupted. Retry to continue.");
    }
    for (const t of a.thread || [])
      if (t.status === "pending") {
        t.status = "error";
        t.error = text("上次请求被中断，请重试", "Previous request interrupted. Retry to continue.");
      }
  }
  return p;
}
async function loadPage(d) {
  if (!d.key) return null;
  if (!pages.has(d.key)) {
    if (!loads.has(d.key))
      loads.set(
        d.key,
        (async () => {
          const stored = (await chrome.storage.local.get(storeKey(d.key)))[storeKey(d.key)];
          const p = stored || { url: d.path, title: d.title, annotations: [] };
          if (!Array.isArray(p.annotations)) throw new Error(text("注释数据格式不正确", "Invalid notes data"));
          recoverInterrupted(p);
          pages.set(d.key, p);
          return p;
        })().finally(() => loads.delete(d.key)),
      );
    await loads.get(d.key);
  }
  const p = pages.get(d.key);
  p.url = d.path;
  p.title = d.title;
  return p;
}
async function persist(key, p) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const stored = (await chrome.storage.local.get(storeKey(key)))[storeKey(key)] || null;
    mergeStored(key, p, stored);
    p.updatedAt = stamp(p.updatedAt, stored?.updatedAt);
    const result = await native("write", {
      key: storeKey(key),
      value: JSON.stringify(p),
      expected: JSON.stringify(stored),
    });
    if (result?.conflict) continue;
    if (doc.key === key) await syncHighlights();
    return;
  }
  throw new Error(text("其他窗口正在更新注释，请重试", "Another window is updating notes. Please retry."));
}
function mergeStored(key, p, stored) {
  mergePage(p, stored, (id, turnId) => {
    const ctrl = jobs.get(jobKey(key, id, turnId));
    return ctrl && !ctrl.signal.aborted;
  });
  for (const [job, ctrl] of jobs) {
    const [documentKey, id, turnId] = job.split("\0");
    if (documentKey !== key) continue;
    const a = p.annotations.find((a) => a.id === id);
    if (!a || (turnId && !a.thread.some((t) => t.id === turnId))) ctrl.abort();
  }
  if (autoSpeech?.key === key && !p.annotations.some((a) => a.id === autoSpeech.id)) cancelAutoSpeech();
}
async function syncHighlights() {
  const items = (page?.annotations || []).flatMap((a) =>
    (a.anchor?.ranges || []).map((r) => ({ id: a.id, page: r.page, start: r.start, end: r.end, ipa: a.ipa || "" })),
  );
  await native("highlights", { key: doc.key || "", items: JSON.stringify(items) });
}
async function changeDocument(d) {
  const epoch = ++documentEpoch,
    changed = d.key !== doc.key;
  doc = d;
  if (changed) {
    cancelAutoSpeech();
    page = null;
    active = null;
    lastPositions = [];
    $("#cards").style.paddingTop = "";
    render();
  }
  const p = await loadPage(d);
  if (epoch !== documentEpoch) return p;
  page = p;
  $("#doc-title").textContent = d.title || text("未打开文档", "No document open");
  $("#doc-title").title = d.path || "";
  render();
  await syncHighlights();
  return p;
}
function sorted() {
  return [...(page?.annotations || [])].sort(
    (a, b) =>
      (a.anchor?.ranges?.[0]?.page || 0) - (b.anchor?.ranges?.[0]?.page || 0) ||
      (a.anchor?.ranges?.[0]?.start || 0) - (b.anchor?.ranges?.[0]?.start || 0),
  );
}
function setActive() {
  for (const card of $("#cards").children) card.classList.toggle("active", card.dataset.id === active);
}
async function goTo(a, key) {
  if (key !== doc.key) return;
  active = a.id;
  following = true;
  setActive();
  await native("goto", { key, id: a.id });
  requestAnimationFrame(() => align(lastPositions));
}
function updateAnswer(key, a, turn, full, partial) {
  if (doc.key !== key) return;
  const card = document.getElementById(`ann-${a.id}`);
  if (!card) return;
  if (turn) {
    const answer = document.getElementById(`answer-${turn.id}`);
    if (answer) answer.innerHTML = renderMarkdown(full);
  } else {
    const parsed = parseNote(full, partial);
    card.querySelector(".ipa").textContent = parsed.ipa;
    card.querySelector(".meaning").textContent = parsed.note;
    card.querySelector(".detail-body").innerHTML = renderMarkdown(parsed.detail);
    card.querySelector("details").hidden = !parsed.detail;
  }
  requestAnimationFrame(() => align(lastPositions));
}
function makeCard(a, key, p) {
  const stateKey = viewKey(key, a.id);
  const card = node("article", `card${active === a.id ? " active" : ""}`);
  card.id = `ann-${a.id}`;
  card.dataset.id = a.id;
  const sentence = a.quote.split(/\s+/).length > 6 || a.quote.length > 60;
  const head = node("div", sentence ? "card-head sentence" : "card-head");
  const quote = button(a.quote, () => goTo(a, key), "quote");
  quote.title = text("跳回原文", "Go to source");
  card.append(head);
  const tools = node("div", "tools");
  const detailToggle = button(
    expanded.has(stateKey) ? text("⌄ 详解", "⌄ Details") : text("› 详解", "› Details"),
    () => {
      const detail = card.querySelector("details");
      detail.open = !detail.open;
      if (detail.open) expanded.add(stateKey);
      else expanded.delete(stateKey);
      detailToggle.textContent = detail.open ? text("⌄ 详解", "⌄ Details") : text("› 详解", "› Details");
      requestAnimationFrame(() => align(lastPositions));
    },
    "detail-toggle",
  );
  const speaker = setIcon(
    button("", () => speakNote(key, a, speaker)),
    "speak",
    text("朗读", "Read"),
  );
  speaker.title = text("美式女声 · 0.8 倍语速", "American female voice · 0.8×");
  speaker.classList.add("inline-speak");
  head.append(quote, speaker, node("span", "ipa", a.ipa), node("span", "meaning", a.note));
  const ask = setIcon(
    button("", () => {
      asking.add(stateKey);
      render();
      document.getElementById(`ask-${a.id}`)?.focus();
    }),
    "ask",
    text("追问", "Ask"),
  );
  const regen = setIcon(
    button("", () => runJob(key, p, a)),
    "regen",
    text("重新生成", "Regenerate"),
  );
  if (a.model) regen.title += ` · ${a.model}`;
  const copy = setIcon(
    button("", async () => {
      const turns = (a.thread || []).map((t) => `**${t.q}**\n\n${t.a}`).join("\n\n");
      if (
        await native("copy", {
          value: `**${a.quote}** ${a.ipa || ""}\n\n${noteForContext(a)}${turns ? "\n\n" + turns : ""}`,
        })
      )
        toast(text("已复制 Markdown", "Markdown copied"));
    }),
    "copy",
    text("复制", "Copy"),
  );
  tools.append(
    detailToggle,
    ask,
    regen,
    copy,
    setIcon(
      button("", () => deleteNote(a, key, p)),
      "del",
      text("删除", "Delete"),
    ),
  );
  const sourcePage = a.anchor?.ranges?.[0]?.page;
  if (sourcePage) tools.append(button(text(`第 ${sourcePage} 页`, `p. ${sourcePage}`), () => goTo(a, key), "page"));
  card.append(tools);
  const details = node("details", "detail");
  details.hidden = !a.detail;
  details.open = expanded.has(stateKey);
  details.append(node("summary", "", text("详解", "Details")));
  const detailBody = node("div", "detail-body");
  detailBody.innerHTML = renderMarkdown(a.detail);
  details.append(detailBody);
  details.addEventListener("toggle", () => {
    if (details.open) expanded.add(stateKey);
    else expanded.delete(stateKey);
  });
  card.append(details);
  if (a.status === "pending") card.append(node("div", "pending", text("正在生成…", "Generating…")));
  if (a.error) card.append(node("div", "error", a.error));
  if (a.model) card.append(node("span", "model", a.model));
  for (const turn of a.thread || []) {
    const box = node("section", "turn");
    box.append(node("div", "question", turn.q));
    const answer = node("div", "answer");
    answer.id = `answer-${turn.id}`;
    answer.innerHTML = renderMarkdown(turn.a);
    box.append(answer);
    if (turn.status === "pending") box.append(node("div", "pending", text("正在回答…", "Answering…")));
    if (turn.error) box.append(node("div", "error", turn.error));
    const actions = node("div", "tools");
    actions.append(
      button(text("重试", "Retry"), () => runJob(key, p, a, turn)),
      button(text("删除问答", "Delete turn"), async () => {
        jobs.get(jobKey(key, a.id, turn.id))?.abort();
        a._deletedTurns = { ...a._deletedTurns, [turn.id]: stamp(revision(turn), a._deletedTurns?.[turn.id]) };
        a.thread = a.thread.filter((t) => t.id !== turn.id);
        await withLock(() => persist(key, p));
        if (doc.key === key) render();
      }),
    );
    box.append(actions);
    card.append(box);
  }
  if (asking.has(stateKey)) {
    const askBox = node("div", "ask-box"),
      input = node("textarea");
    input.id = `ask-${a.id}`;
    input.placeholder = text(
      "继续追问… Enter 发送，Shift+Enter 换行",
      "Ask a question… Enter to send, Shift+Enter for a new line",
    );
    input.value = drafts.get(stateKey) || "";
    input.addEventListener("input", () => drafts.set(stateKey, input.value));
    const send = async () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      drafts.delete(stateKey);
      const createdAt = stamp();
      const turn = { id: crypto.randomUUID(), q, a: "", status: "pending", createdAt, updatedAt: createdAt };
      a.thread ||= [];
      a.thread.push(turn);
      await runJob(key, p, a, turn);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send().catch(showError);
      }
      if (e.key === "Escape") {
        asking.delete(stateKey);
        render();
      }
    });
    const actions = node("div", "ask-actions");
    actions.append(
      button(text("发送", "Send"), send),
      button(text("收起", "Close"), () => {
        asking.delete(stateKey);
        render();
      }),
    );
    askBox.append(input, actions);
    card.append(askBox);
  }
  return card;
}
function render() {
  const focused = document.activeElement?.id,
    selection = document.activeElement?.selectionStart;
  $("#cards").replaceChildren(...sorted().map((a) => makeCard(a, doc.key, page)));
  $("#empty").hidden = !!page?.annotations.length;
  $("#status").textContent = text(
    `${page?.annotations.length || 0} 条注释 · 仅保存在本机`,
    `${page?.annotations.length || 0} notes · Stored locally`,
  );
  if (focused?.startsWith("ask-")) {
    const input = document.getElementById(focused);
    input?.focus({ preventScroll: true });
    if (selection != null) input?.setSelectionRange(selection, selection);
  }
  requestAnimationFrame(() => align(lastPositions));
}
function targetExists(p, a, turn) {
  return p.annotations.includes(a) && (!turn || a.thread?.includes(turn));
}
async function runJob(key, p, a, turn = null) {
  const job = jobKey(key, a.id, turn?.id);
  jobs.get(job)?.abort();
  const ctrl = new AbortController();
  jobs.set(job, ctrl);
  const target = turn || a;
  target.status = "pending";
  target.error = null;
  target.updatedAt = stamp(revision(target));
  if (doc.key === key) render();
  let latest = "",
    lastPaint = 0;
  try {
    const modelSettings = await getSettings();
    await withLock(() => persist(key, p));
    if (!turn && a._statsPending === true) {
      await native("recordVocabulary", { id: a.id, createdAt: a.createdAt })
        .then(() => {
          a._statsPending = false;
        })
        .catch(showError);
    }
    if (ctrl.signal.aborted || !targetExists(p, a, turn)) return;
    const args = {
      settings: modelSettings,
      page: p,
      ann: a,
      turnId: turn?.id,
      signal: ctrl.signal,
      onText(full) {
        latest = full;
        if (ctrl.signal.aborted || Date.now() - lastPaint < 80) return;
        lastPaint = Date.now();
        updateAnswer(key, a, turn, full, true);
      },
    };
    const result = await (turn ? generateFollowup(args) : generateNote(args));
    if (ctrl.signal.aborted || !targetExists(p, a, turn)) return;
    Object.assign(target, turn ? { a: result.text } : parseNote(result.text), {
      status: "done",
      model: result.model,
      error: null,
      updatedAt: stamp(revision(target)),
    });
  } catch (err) {
    if (ctrl.signal.aborted || !targetExists(p, a, turn)) return;
    Object.assign(target, turn ? { a: latest } : parseNote(latest), {
      status: "error",
      error: String(err?.message || err),
      updatedAt: stamp(revision(target)),
    });
  } finally {
    if (jobs.get(job) === ctrl) {
      jobs.delete(job);
      if (!ctrl.signal.aborted && targetExists(p, a, turn)) {
        await withLock(() => persist(key, p));
        if (doc.key === key) render();
      }
    }
  }
}
async function annotate(selection) {
  if (!selection?.key || !selection.quote?.trim()) return;
  const speechEpoch = ++annotationEpoch;
  cancelAutoSpeech();
  const p = doc.key === selection.key ? await changeDocument(selection) : await loadPage(selection),
    key = selection.key;
  const ranges = selection.ranges || [];
  const existing = p.annotations.find(
    (a) => a.quote === selection.quote && JSON.stringify(a.anchor?.ranges) === JSON.stringify(ranges),
  );
  if (existing) {
    if (doc.key === key) {
      active = existing.id;
      following = true;
      render();
      await syncHighlights();
    }
    return;
  }
  const a = {
    id: crypto.randomUUID(),
    quote: selection.quote,
    context: selection.context,
    anchor: { ranges },
    createdAt: stamp(),
    _statsPending: true,
    status: "pending",
    note: "",
    ipa: "",
    detail: "",
    thread: [],
  };
  p.annotations.push(a);
  if (doc.key === key) {
    active = a.id;
    following = true;
  }
  if (doc.key === key && speechEpoch === annotationEpoch) speakNewNote(key, a);
  await runJob(key, p, a);
}
function abortNote(key, id) {
  if (autoSpeech?.key === key && autoSpeech.id === id) cancelAutoSpeech();
  const prefix = jobKey(key, id);
  for (const [job, ctrl] of jobs) if (job.startsWith(prefix)) ctrl.abort();
}
async function deleteNote(a, key, p) {
  abortNote(key, a.id);
  const index = p.annotations.indexOf(a);
  if (index < 0) return;
  p._deletedNotes = { ...p._deletedNotes, [a.id]: stamp(revision(a), p._deletedNotes?.[a.id]) };
  p.annotations.splice(index, 1);
  await withLock(() => persist(key, p));
  if (doc.key === key) render();
  toast(text("已删除注释及追问", "Note and follow-ups deleted"), async () => {
    recoverInterrupted({ annotations: [a] });
    a.updatedAt = stamp(revision(a), p._deletedNotes?.[a.id]);
    for (const t of a.thread || []) t.updatedAt = stamp(revision(t), a._deletedTurns?.[t.id]);
    if (!p.annotations.some((n) => n.id === a.id)) p.annotations.splice(index, 0, a);
    await withLock(() => persist(key, p));
    if (doc.key === key) render();
  });
}
function align(positions) {
  if (!following || !active) return;
  const position = positions.find((p) => p.id === active),
    card = document.getElementById(`ann-${active}`);
  if (!position || !card || position.y < 60 || position.y > innerHeight - 60) return;
  const target = Math.max(95, position.y),
    delta = card.getBoundingClientRect().top - target;
  if (scrollY + delta < 0)
    $("#cards").style.paddingTop = `${parseFloat(getComputedStyle($("#cards")).paddingTop) - scrollY - delta}px`;
  $("#cards").style.paddingBottom = `${innerHeight}px`;
  scrollBy(0, card.getBoundingClientRect().top - target);
}
function applyZoom(value) {
  settings.panelZoom = Math.max(60, Math.min(220, Number(value) || 100));
  document.documentElement.style.setProperty("--scale", settings.panelZoom / 100);
  $("#zoom").textContent = `${settings.panelZoom}%`;
  requestAnimationFrame(() => align(lastPositions));
}
function zoom(value) {
  applyZoom(value);
  saveSettings({ panelZoom: settings.panelZoom }).catch(showError);
}
$("#smaller").onclick = () => zoom(settings.panelZoom - 10);
$("#larger").onclick = () => zoom(settings.panelZoom + 10);
$("#zoom").onclick = () => zoom(100);
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(settings.panelZoom + (e.deltaY < 0 ? 10 : -10));
    } else following = false;
  },
  { passive: false },
);
document.addEventListener("touchmove", () => (following = false), { passive: true });
window.addEventListener("keydown", (e) => {
  const typing = /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName);
  if (!typing && /^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key)) following = false;
});
window.addEventListener("mousedown", (e) => {
  if (e.clientX >= document.documentElement.clientWidth) following = false;
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "0"].includes(e.key)) {
    e.preventDefault();
    zoom(e.key === "0" ? 100 : settings.panelZoom + (e.key === "-" ? -10 : 10));
  }
});
$("#cards").addEventListener("mouseup", (e) => {
  const selected = getSelection()?.toString().trim(),
    card = e.target.closest(".card");
  if (!selected || !card || !e.target.closest(".detail-body,.answer")) return;
  const a = page.annotations.find((a) => a.id === card.dataset.id),
    stateKey = viewKey(doc.key, a.id),
    key = doc.key;
  toast(
    text("解释选中的这段内容", "Explain this selection"),
    () => {
      drafts.set(
        stateKey,
        text(`请再解释一下你上面提到的「${selected}」`, `Please explain what you meant by “${selected}”.`),
      );
      asking.add(stateKey);
      if (doc.key === key) {
        render();
        document.getElementById(`ask-${a.id}`)?.focus();
      }
    },
    text("解释这段", "Explain"),
  );
});

const form = $("#settings-form"),
  dialog = $("#settings-dialog");
function models(provider, reset) {
  const p = PROVIDERS[provider] || PROVIDERS.gemini;
  $("#models").replaceChildren(
    ...p.models.map((m) => {
      const o = node("option");
      o.value = m;
      return o;
    }),
  );
  form.elements.baseUrl.placeholder = p.baseUrl;
  if (reset) {
    form.elements.model.value = p.defaultModel;
    form.elements.baseUrl.value = "";
  }
}
async function openSettings() {
  settings = await getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
  }
  form.elements.systemPrompt.placeholder = DEFAULT_SYSTEM_PROMPT;
  form.elements.followupPrompt.placeholder = DEFAULT_FOLLOWUP_PROMPT;
  models(settings.provider, false);
  $("#test-result").textContent = "";
  if (!dialog.open) dialog.showModal();
}
function formSettings() {
  const values = Object.fromEntries(new FormData(form)),
    raw = values.apiKey.trim();
  values.apiKey =
    /(?:x-goog-api-key|x-api-key)\s*:\s*([^\s'"\\]+)/i.exec(raw)?.[1] ||
    /[?&]key=([^&\s'"\\]+)/.exec(raw)?.[1] ||
    /Bearer\s+([^\s'"\\]+)/i.exec(raw)?.[1] ||
    raw;
  values.clickToAnnotate = form.elements.clickToAnnotate.checked;
  return { ...settings, ...values };
}
$("#settings").onclick = $("#setup").onclick = () => openSettings().catch(showError);
form.elements.provider.onchange = () => models(form.elements.provider.value, true);
$("#cancel-settings").onclick = () => dialog.close();
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    settings = await saveSettings(formSettings());
    await native("preferences", { click: settings.clickToAnnotate });
    dialog.close();
    toast(text("设置已保存", "Settings saved"));
  } catch (err) {
    showError(err);
  }
};
$("#test").onclick = async () => {
  $("#test").disabled = true;
  $("#test-result").textContent = text("正在连接…", "Connecting…");
  try {
    const result = await testConnection(formSettings());
    $("#test-result").textContent = `${result.model}\n${result.text}`;
  } catch (err) {
    $("#test-result").textContent = String(err?.message || err);
  } finally {
    $("#test").disabled = false;
  }
};
$("#close").onclick = () => native("closeNotes").catch(showError);
$("#export").onclick = async () => {
  try {
    const all = await chrome.storage.local.get(null),
      exported = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("page:")));
    await native("export", {
      value: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), pages: exported }, null, 2),
    });
  } catch (err) {
    showError(err);
  }
};
function validateImport(data) {
  const imported = data?.pages || data;
  if (!imported || typeof imported !== "object" || Array.isArray(imported))
    throw new Error(text("注释文件格式不正确", "Invalid notes file"));
  const entries = Object.entries(imported).filter(([key]) => key.startsWith("page:"));
  for (const [, p] of entries) {
    if (!p || !Array.isArray(p.annotations)) throw new Error(text("注释文件格式不正确", "Invalid notes file"));
    for (const a of p.annotations) {
      if (
        !a ||
        typeof a.id !== "string" ||
        !a.id ||
        a.id.length > 200 ||
        a.id.includes("\0") ||
        typeof a.quote !== "string" ||
        (a.thread &&
          (!Array.isArray(a.thread) ||
            !a.thread.every(
              (t) =>
                t &&
                typeof t.id === "string" &&
                t.id &&
                t.id.length <= 200 &&
                !t.id.includes("\0") &&
                typeof t.q === "string" &&
                typeof t.a === "string",
            )))
      )
        throw new Error(text("注释文件格式不正确", "Invalid notes file"));
      if (["note", "detail", "ipa", "context"].some((field) => a[field] != null && typeof a[field] !== "string"))
        throw new Error(text("注释文件格式不正确", "Invalid notes file"));
      if (
        a.anchor?.ranges != null &&
        (!Array.isArray(a.anchor.ranges) ||
          !a.anchor.ranges.every(
            (r) =>
              r &&
              Number.isSafeInteger(r.page) &&
              r.page > 0 &&
              Number.isSafeInteger(r.start) &&
              r.start >= 0 &&
              Number.isSafeInteger(r.end) &&
              r.end >= r.start,
          ))
      )
        throw new Error(text("注释定位格式不正确", "Invalid note anchors"));
      for (const item of [a, ...(a.thread || [])])
        if (
          ["createdAt", "updatedAt"].some(
            (field) => item[field] != null && (!Number.isSafeInteger(item[field]) || item[field] < 0),
          )
        )
          throw new Error(text("注释时间格式不正确", "Invalid note timestamp"));
    }
  }
  if (!entries.length) throw new Error(text("文件中没有注释", "No notes found in the file"));
  return entries;
}
$("#import").onclick = () => $("#import-file").click();
$("#import-file").onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) throw new Error(text("文件超过 30 MB", "File exceeds 30 MB"));
    const entries = validateImport(JSON.parse(await file.text()));
    await withLock(async () => {
      const all = await chrome.storage.local.get(null);
      for (const [key, imported] of entries) {
        const documentKey = key.slice(5),
          current = pages.get(documentKey) || all[key] || { ...imported, annotations: [] };
        const ids = new Set(current.annotations.map((a) => a.id));
        for (const a of imported.annotations)
          if (!ids.has(a.id)) {
            a.updatedAt = stamp(revision(a), current._deletedNotes?.[a.id]);
            for (const t of a.thread || []) t.updatedAt = stamp(revision(t), a._deletedTurns?.[t.id]);
            recoverInterrupted({ annotations: [a] });
            current.annotations.push(a);
            ids.add(a.id);
          }
        pages.set(documentKey, current);
        await persist(documentKey, current);
      }
    });
    await changeDocument(doc);
    toast(text("注释已导入", "Notes imported"));
  } catch (err) {
    showError(err);
  } finally {
    e.target.value = "";
  }
};
let clearArmed = false;
$("#clear").onclick = async () => {
  if (!clearArmed) {
    clearArmed = true;
    $("#clear").textContent = text("再次点击清空", "Click again to clear");
    setTimeout(() => {
      clearArmed = false;
      $("#clear").textContent = text("清空注释", "Clear notes");
    }, 3000);
    return;
  }
  try {
    cancelAutoSpeech();
    for (const ctrl of jobs.values()) ctrl.abort();
    await withLock(async () => {
      const all = await chrome.storage.local.get(null);
      const keys = new Set([
        ...Object.keys(all).filter((k) => k.startsWith("page:")),
        ...[...pages.keys()].map(storeKey),
      ]);
      for (const key of keys) {
        const documentKey = key.slice(5),
          stored = all[key],
          p = pages.get(documentKey) || stored;
        if (!p) continue;
        p._deletedNotes ||= {};
        for (const a of [...(stored?.annotations || []), ...p.annotations])
          p._deletedNotes[a.id] = stamp(revision(a), p._deletedNotes[a.id]);
        p.annotations = [];
        await persist(documentKey, p);
      }
      pages.clear();
      drafts.clear();
      asking.clear();
      expanded.clear();
    });
    await changeDocument(doc);
    toast(text("已清空注释", "Notes cleared"));
  } catch (err) {
    showError(err);
  }
};
window.addEventListener("documentchange", (e) => {
  annotationEpoch++;
  cancelAutoSpeech();
  changeDocument(e.detail).catch(showError);
});
window.addEventListener("annotate", (e) => annotate(e.detail).catch(showError));
window.addEventListener("deletenote", (e) => {
  const { key, id } = e.detail;
  const remove = async () => {
    const p =
      pages.get(key) ||
      (await loadPage({ key, path: doc.key === key ? doc.path : "", title: doc.key === key ? doc.title : "" }));
    const a = p?.annotations.find((a) => a.id === id);
    if (a) await deleteNote(a, key, p);
  };
  remove().catch(showError);
});
window.addEventListener("speaknote", (e) => {
  const { key, id } = e.detail || {};
  if (key !== doc.key) return;
  const a = page?.annotations.find((a) => a.id === id);
  if (!a) return;
  const btn = document.getElementById(`ann-${id}`)?.querySelector(".inline-speak");
  Promise.resolve(speakNote(key, a, btn)).catch(showError);
});
window.addEventListener("focusnote", (e) => {
  active = e.detail.id;
  following = true;
  setActive();
  document.getElementById(`ann-${active}`)?.scrollIntoView({ block: "center" });
  requestAnimationFrame(() => align(lastPositions));
});
window.addEventListener("notepositions", (e) => {
  lastPositions = e.detail;
  align(lastPositions);
});
window.addEventListener("showsettings", () => openSettings().catch(showError));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings)
    getSettings()
      .then((s) => {
        settings = s;
        applyZoom(s.panelZoom);
        return native("preferences", { click: s.clickToAnnotate });
      })
      .catch(showError);
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("page:") || !Array.isArray(change.newValue?.annotations)) continue;
    const documentKey = key.slice(5),
      p = pages.get(documentKey);
    if (!p || JSON.stringify(p) === JSON.stringify(change.newValue)) continue;
    mergeStored(documentKey, p, change.newValue);
    if (doc.key === documentKey) {
      page = p;
      render();
      syncHighlights().catch(showError);
    }
  }
});
if (!zh) {
  $("#brand").textContent = "AI notes";
  $("#empty").replaceChildren(
    node("strong", "", "Read words in context"),
    node("p", "", "Click an English word, or select text and choose “AI note”."),
    node("p", "", "Alt + Shift + A · Annotate\nCtrl + Shift + A · Toggle notes"),
    button("Configure AI", openSettings),
  );
  $("h2").textContent = "AI settings";
  for (const [name, label] of Object.entries({
    provider: "Provider",
    apiKey: "API key",
    baseUrl: "API base URL",
    model: "Model",
    effort: "Thinking effort",
    ipa: "Pronunciation",
    systemPrompt: "Note prompt",
    followupPrompt: "Follow-up prompt",
  }))
    form.elements.namedItem(name).closest("label").firstChild.textContent = label;
  for (const [index, label] of ["American", "British", "Off"].entries())
    form.elements.ipa.options[index].textContent = label;
  const checkbox = form.elements.clickToAnnotate;
  checkbox.closest("label").replaceChildren(checkbox, document.createTextNode("Click an English word to annotate"));
  for (const [id, label] of Object.entries({
    test: "Test connection",
    "cancel-settings": "Cancel",
    export: "Export notes",
    import: "Import notes",
    clear: "Clear notes",
  }))
    document.getElementById(id).textContent = label;
  form.querySelector("button[type=submit]").textContent = "Save";
  form.querySelector(".muted").textContent =
    "Settings and notes are stored on this computer. Selected text and context are sent only to the configured API.";
  $("#settings").title = "Settings";
  $("#close").title = "Close";
}
applyZoom(settings.panelZoom);
const initial = await native("ready", { click: settings.clickToAnnotate });
if (initial.network) enableNativeNetwork();
await changeDocument(initial.document);
for (const selection of initial.selections || (initial.selection ? [initial.selection] : []))
  annotate(selection).catch(showError);
if (initial.settings) await openSettings();
