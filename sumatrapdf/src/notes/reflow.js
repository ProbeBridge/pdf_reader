import { safeReflowContent, SourcePage } from "./reflow-model.js";

const $ = (selector) => document.querySelector(selector),
  zh = navigator.language.startsWith("zh");
const call = (action, data = {}) => globalThis.__sumatra__.call("reflow", JSON.stringify({ action, ...data }));
const say = (cn, en) => (zh ? cn : en);
let info,
  notes = [],
  clickEnabled = true,
  zoom = 100,
  current = 1,
  epoch = 0,
  checking = false,
  selectedNote,
  clickTimer;
const pages = new Map(),
  pending = new Map(),
  inFlight = new Set();
const orderedPages = () => [...pages.values()].sort((a, b) => a.page - b.page);
function error(reason) {
  $("#status").textContent = reason?.message || String(reason);
}
function fitTables() {
  const canvas = document.createElement("canvas").getContext("2d");
  const tables = [...document.querySelectorAll(".page-content table")];
  for (const table of tables) table.style.removeProperty("font-size");
  for (const table of tables) {
    const columns = Math.max(
      1,
      ...[...table.rows].map((row) => [...row.cells].reduce((n, cell) => n + cell.colSpan, 0)),
    );
    const style = getComputedStyle(table),
      target = parseFloat(style.fontSize);
    const parent = getComputedStyle(table.parentElement);
    const available =
      table.parentElement.clientWidth - parseFloat(parent.paddingLeft) - parseFloat(parent.paddingRight);
    const cell = table.querySelector("th,td");
    if (!cell || available <= 0 || !target) continue;
    const cellStyle = getComputedStyle(cell);
    const padding = (parseFloat(cellStyle.paddingLeft) + parseFloat(cellStyle.paddingRight)) / target;
    canvas.font = `${style.fontStyle} 700 ${target}px ${style.fontFamily}`;
    let glyph = 1;
    for (const char of new Set(Array.from(table.textContent)))
      glyph = Math.max(glyph, canvas.measureText(char).width / target);
    const border = parseFloat(cellStyle.borderLeftWidth) + parseFloat(cellStyle.borderRightWidth);
    const limit = Math.max(0.5, (available / columns - border) / (glyph + padding));
    table.style.fontSize = `${Math.min(target, limit)}px`;
  }
}
if (!zh) {
  $("#previous").textContent = "Previous page";
  $("#next").textContent = "Next page";
  $("#annotate").textContent = "AI note on selected text";
  $("#original").textContent = "Original view";
  $("#focus-note").textContent = "View note";
  $("#delete-note").textContent = "Delete";
}
function label() {
  $("#page-label").textContent = `${current} / ${info.pageCount} · ${zoom}%`;
  $("#previous").disabled = current <= 1;
  $("#next").disabled = current >= info.pageCount;
}
function anchor() {
  const top = $("nav").getBoundingClientRect().bottom;
  const area = $("#pages").getBoundingClientRect();
  let fallback;
  // A source page can contain a very long table or paragraph. Pin a visible
  // glyph rather than the page's top, which can be thousands of pixels away.
  for (let y = top + 12; y < Math.min(innerHeight - 8, top + 260); y += 24) {
    for (const fraction of [0.15, 0.5, 0.85]) {
      const caret = document.caretRangeFromPoint(area.left + area.width * fraction, y);
      const node = caret?.startContainer;
      if (node?.nodeType !== Node.TEXT_NODE || !node.data.trim()) continue;
      const section = node.parentElement.closest(".source-page");
      if (!section || !node.parentElement.closest(".page-content")) continue;
      let offset = Math.min(caret.startOffset, node.length - 1);
      if (node.data.charCodeAt(offset) >= 0xdc00 && node.data.charCodeAt(offset) <= 0xdfff) offset--;
      while (offset < node.length && /\s/u.test(node.data[offset])) offset++;
      if (offset >= node.length) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + (node.data.codePointAt(offset) > 0xffff ? 2 : 1));
      const rect = range.getBoundingClientRect();
      if (
        rect.height <= 0 ||
        rect.bottom <= top ||
        rect.top >= innerHeight ||
        Math.abs(rect.top + rect.height / 2 - y) > rect.height + 24
      )
        continue;
      const saved = { range, section, top: rect.top, sectionTop: section.getBoundingClientRect().top };
      if (Number(section.dataset.page) === current) return saved;
      fallback ||= saved;
    }
  }
  const currentPage = pages.get(current);
  if (currentPage) {
    const rect = currentPage.section.getBoundingClientRect();
    if (rect.top < innerHeight && rect.bottom > top) {
      const image = [...currentPage.content.querySelectorAll("img")].find((image) => {
        const bounds = image.getBoundingClientRect();
        return bounds.top < innerHeight && bounds.bottom > top;
      });
      if (image)
        return {
          section: currentPage.section,
          element: image,
          top: image.getBoundingClientRect().top,
          sectionTop: rect.top,
        };
      return { section: currentPage.section, sectionTop: rect.top };
    }
  }
  if (fallback) return fallback;
  const page = orderedPages().find((p) => p.section.getBoundingClientRect().bottom > top);
  return page && { section: page.section, sectionTop: page.section.getBoundingClientRect().top };
}
function restore(saved) {
  if (!saved?.section.isConnected) return;
  if (saved.range?.startContainer.isConnected) scrollBy(0, saved.range.getBoundingClientRect().top - saved.top);
  else if (saved.element?.isConnected) scrollBy(0, saved.element.getBoundingClientRect().top - saved.top);
  else scrollBy(0, saved.section.getBoundingClientRect().top - saved.sectionTop);
}
async function load(page, token = epoch) {
  if (page < 1 || page > info.pageCount || token !== epoch) return;
  if (pages.has(page)) return pages.get(page);
  if (pending.has(page)) return pending.get(page);
  const promise = (async () => {
    while (inFlight.size >= 3) {
      await Promise.race([...inFlight].map((request) => request.catch(() => {})));
      if (token !== epoch) return;
    }
    if (token !== epoch) return;
    const request = Promise.resolve().then(() => call("page", { page }));
    inFlight.add(request);
    let result;
    try {
      result = await request;
    } catch (e) {
      if (token !== epoch) return;
      throw e;
    } finally {
      inFlight.delete(request);
    }
    if (token !== epoch) return;
    if (result.error) throw new Error(result.error);
    const section = document.createElement("section"),
      heading = document.createElement("span"),
      content = document.createElement("div");
    section.className = "source-page";
    section.dataset.page = String(page);
    heading.className = "page-number";
    heading.textContent = `${say("原文第", "Source page")} ${page}${say("页", "")}`;
    content.className = "page-content";
    content.append(safeReflowContent(result.html));
    if (!content.textContent.trim() && !content.querySelector("img"))
      content.textContent = say("本页没有可重排的文字或图片。", "This page has no text or images to reflow.");
    section.append(heading, content);
    const saved = anchor(),
      next = orderedPages().find((p) => p.page > page);
    $("#pages").insertBefore(section, next?.section || null);
    const entry = {
      page,
      section,
      content,
      model: new SourcePage(content, page, result.sourceText || "", result.displayText),
    };
    pages.set(page, entry);
    fitTables();
    restore(saved);
    drawNotes();
    return entry;
  })().finally(() => {
    if (pending.get(page) === promise) pending.delete(page);
  });
  pending.set(page, promise);
  return promise;
}
function clear() {
  clearTimeout(clickTimer);
  epoch++;
  pages.clear();
  pending.clear();
  $("#pages").replaceChildren();
  hideActions();
  globalThis.CSS?.highlights?.delete("ai-notes");
}
async function navigate(page) {
  if (!info || page < 1 || page > info.pageCount) return;
  clear();
  const token = epoch;
  current = page;
  label();
  $("#status").textContent = say("正在重排当前页…", "Reflowing this page…");
  const entry = await load(page, token);
  if (!entry || token !== epoch) return;
  await call("position", { page });
  if (token !== epoch) return;
  $("#status").textContent = "";
  scrollTo(0, 0);
  // A bounded window only: opening a 2,000-page PDF never extracts the whole book.
  await Promise.all([load(page - 1, token), load(page + 1, token)]);
  if (token === epoch) entry.section.scrollIntoView({ block: "start" });
  positions();
}
function prune() {
  const saved = anchor();
  for (const [number, page] of pages)
    if (Math.abs(number - current) > 2) {
      page.section.remove();
      pages.delete(number);
    }
  restore(saved);
}
async function checkScroll() {
  if (checking || !pages.size) return;
  checking = true;
  try {
    const ordered = orderedPages(),
      top = $("nav").offsetHeight + 12;
    const at = ordered.find((p) => p.section.getBoundingClientRect().bottom > top);
    if (at && at.page !== current) {
      current = at.page;
      label();
      await call("position", { page: current });
    }
    prune();
    if (pages.size + pending.size < 5) {
      const numbers = [...pages.keys()],
        first = Math.min(...numbers),
        last = Math.max(...numbers);
      if (scrollY < 200 && first > 1) await load(first - 1);
      else if (document.documentElement.scrollHeight - innerHeight - scrollY < 300 && last < info.pageCount)
        await load(last + 1);
    }
    positions();
  } catch (e) {
    error(e);
  } finally {
    checking = false;
  }
}
function setZoom(value, notify = true) {
  clearTimeout(clickTimer);
  const saved = anchor();
  zoom = Math.max(50, Math.min(400, Math.round(value)));
  document.documentElement.style.setProperty("--font-scale", String(zoom / 100));
  fitTables();
  label();
  restore(saved);
  drawNotes();
  if (notify) call("zoom", { zoom }).catch(error);
}
function selectionPayload(range) {
  const ranges = [],
    contexts = [],
    quotes = [];
  for (const page of orderedPages()) {
    if (!range.intersectsNode(page.content)) continue;
    const found = page.model.selection(range);
    if (found.length) {
      ranges.push(...found);
      const chars = Array.from(page.model.displayText),
        first = found[0].start,
        last = found.at(-1).end;
      contexts.push(chars.slice(Math.max(0, first - 1200), Math.min(chars.length, last + 1200)).join(""));
      quotes.push(found.map((item) => chars.slice(item.start, item.end).join("")).join("\n"));
    }
  }
  if (!ranges.length)
    throw new Error(say("请选择可定位到原文的文字。", "Select text that can be located in the original document."));
  return { quote: quotes.join("\n").trim(), context: contexts.join("\n"), ranges: JSON.stringify(ranges) };
}
async function annotate(range) {
  const payload = selectionPayload(range);
  if (payload.quote) await call("annotate", payload);
}
$("#annotate").addEventListener("mousedown", (e) => e.preventDefault());
$("#annotate").addEventListener("click", () => {
  const selection = getSelection();
  if (selection?.rangeCount && !selection.isCollapsed) annotate(selection.getRangeAt(0).cloneRange()).catch(error);
});
$("#previous").addEventListener("click", () => navigate(current - 1).catch(error));
$("#next").addEventListener("click", () => navigate(current + 1).catch(error));
$("#original").addEventListener("click", () => call("close").catch(error));
function allNoteRanges() {
  return notes.flatMap(
    (note) =>
      pages
        .get(note.page)
        ?.model.domRanges(note.start, note.end)
        .map((range) => ({ note, range })) || [],
  );
}
function drawNotes() {
  const saved = anchor();
  fitTables();
  restore(saved);
  const context = document.createElement("canvas").getContext("2d");
  for (const page of pages.values()) page.content.querySelector(".note-ink-layer")?.remove();
  for (const page of pages.values()) {
    const layer = document.createElement("div");
    layer.className = "note-ink-layer";
    layer.setAttribute("aria-hidden", "true");
    const origin = page.content.getBoundingClientRect();
    for (const note of notes.filter((note) => note.page === page.page))
      for (const range of page.model.domRanges(note.start, note.end)) {
        const style = getComputedStyle(range.startContainer.parentElement);
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = context.measureText(range.toString()),
          fontSize = parseFloat(style.fontSize);
        for (const rect of range.getClientRects()) {
          const height = Math.min(
            rect.height,
            fontSize,
            Math.max(1, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent),
          );
          const mark = document.createElement("span");
          mark.className = "note-ink";
          mark.dataset.note = note.id;
          mark.style.left = `${rect.left - origin.left}px`;
          mark.style.top = `${rect.top - origin.top + (rect.height - height) / 2}px`;
          mark.style.width = `${rect.width}px`;
          mark.style.height = `${height}px`;
          layer.append(mark);
        }
      }
    page.content.append(layer);
  }
  positions();
}
function positions() {
  if (!info) return;
  const visible = new Map();
  for (const { note, range } of allNoteRanges()) {
    const rect = range.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < innerHeight)
      visible.set(note.id, Math.min(visible.get(note.id) ?? Infinity, rect.top));
  }
  const items = [...visible].map(([id, y]) => ({ id, y })),
    serialized = JSON.stringify(items);
  if (positions.previous !== serialized) {
    positions.previous = serialized;
    call("positions", { items: serialized }).catch(error);
  }
}
function noteAtPoint(x, y) {
  return allNoteRanges().find(({ range }) =>
    [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom),
  )?.note;
}
function hideActions() {
  $("#note-actions").hidden = true;
  selectedNote = null;
}
function showActions(note, x, y) {
  selectedNote = note;
  $("#note-ipa").textContent = note.ipa || "";
  const box = $("#note-actions");
  box.hidden = false;
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - box.offsetHeight - 8))}px`;
  call("focus", { id: note.id }).catch(error);
}
$("#focus-note").addEventListener("click", () => selectedNote && call("focus", { id: selectedNote.id }).catch(error));
$("#delete-note").addEventListener("click", () => {
  if (selectedNote) call("delete", { id: selectedNote.id }).catch(error);
  hideActions();
});
document.addEventListener("pointerdown", (e) => {
  clearTimeout(clickTimer);
  if (!e.target.closest("#note-actions")) hideActions();
});
document.addEventListener("dblclick", () => clearTimeout(clickTimer));
$("#pages").addEventListener("pointermove", (e) => {
  const note = noteAtPoint(e.clientX, e.clientY);
  $("#pages").title = note?.ipa || "";
  $("#pages").style.cursor = note ? "pointer" : "";
});
$("#pages").addEventListener("click", (e) => {
  if (e.ctrlKey || e.altKey || e.shiftKey || e.detail > 1 || !getSelection()?.isCollapsed) return;
  const note = noteAtPoint(e.clientX, e.clientY);
  if (note) {
    showActions(note, e.clientX, e.clientY);
    return;
  }
  if (!clickEnabled) return;
  const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return;
  const range = caret.cloneRange();
  range.expand("word");
  if (
    !range.toString().trim() ||
    !/[a-z]/i.test(range.toString()) ||
    !range.startContainer.parentElement.closest(".page-content") ||
    !range.endContainer.parentElement.closest(".page-content")
  )
    return;
  const clicked = range.getBoundingClientRect();
  clickTimer = setTimeout(() => {
    const now = range.getBoundingClientRect();
    if (
      range.startContainer.isConnected &&
      getSelection()?.isCollapsed &&
      Math.abs(now.top - clicked.top) <= 2 &&
      Math.abs(now.left - clicked.left) <= 2
    )
      annotate(range).catch(error);
  }, 550);
});
document.addEventListener("keydown", (e) => {
  if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key)) clearTimeout(clickTimer);
  if (e.key === "Escape") {
    clearTimeout(clickTimer);
    hideActions();
  }
  if (e.altKey && e.shiftKey && e.code === "KeyA") {
    e.preventDefault();
    $("#annotate").click();
  }
  if (e.ctrlKey && ["+", "=", "-", "0"].includes(e.key)) {
    e.preventDefault();
    setZoom(e.key === "0" ? 100 : zoom * (e.key === "-" ? 1 / 1.1 : 1.1));
  }
});
addEventListener(
  "wheel",
  (e) => {
    clearTimeout(clickTimer);
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY > 0 ? 1 / 1.1 : 1.1));
    }
  },
  { passive: false },
);
let scrollFrame;
addEventListener(
  "scroll",
  () => {
    hideActions();
    if (!scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        checkScroll();
      });
  },
  { passive: true },
);
addEventListener("touchmove", () => clearTimeout(clickTimer), { passive: true });
addEventListener("blur", () => clearTimeout(clickTimer));
addEventListener("resize", () => {
  hideActions();
  drawNotes();
});
addEventListener("reflowstate", (e) => {
  const state = e.detail;
  notes = state.highlights || [];
  clickEnabled = state.click !== false;
  drawNotes();
});
addEventListener("reflowzoom", (e) => setZoom(e.detail.zoom, false));
addEventListener("reflownavigate", (e) => navigate(e.detail.page).catch(error));
addEventListener("reflowfocus", async (e) => {
  try {
    const note = notes.find((n) => n.id === e.detail.id);
    if (!note) return;
    if (!pages.has(note.page)) await navigate(note.page);
    pages
      .get(note.page)
      ?.model.domRanges(note.start, note.end)[0]
      ?.startContainer.parentElement.scrollIntoView({ block: "center" });
    positions();
  } catch (e) {
    error(e);
  }
});
try {
  info = await call("ready");
  notes = info.notes?.highlights || [];
  clickEnabled = info.notes?.click !== false;
  zoom = info.zoom || 100;
  setZoom(zoom, false);
  await navigate(info.page || 1);
} catch (e) {
  error(e);
}
