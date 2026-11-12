import { safeReflowContent, SourcePage } from "./reflow-model.js";

const $ = (selector) => document.querySelector(selector),
  zh = navigator.language.startsWith("zh");
const call = (action, data = {}) => globalThis.__sumatra__.call("reflow", JSON.stringify({ action, ...data }));
const say = (cn, en) => (zh ? cn : en);
document.documentElement.lang = navigator.language;
document.title = say("正文重排", "Text reflow");
for (const [selector, cn, en] of [
  ["#previous", "上一页", "Previous page"],
  ["#next", "下一页", "Next page"],
  ["#annotate", "AI 注释选中文本", "Annotate selected text"],
  ["#original", "原版", "Original view"],
  ["#focus-note", "查看注释", "View annotation"],
  ["#delete-note", "删除", "Delete"],
])
  $(selector).textContent = say(cn, en);
const speakLabel = say("朗读原文", "Read aloud");
$("#speak-note").title = speakLabel;
$("#speak-note").setAttribute("aria-label", speakLabel);
$("#note-actions").setAttribute("aria-label", say("注释操作", "Annotation actions"));
$("nav").setAttribute("aria-label", say("重排阅读", "Reflow reading"));
let info,
  notes = [],
  clickEnabled = true,
  zoom = 100,
  current = 1,
  navigation = 0,
  epoch = 0,
  checking = false,
  navigating = false,
  selectedNote,
  actionAnchor,
  actionHideTimer,
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
function label() {
  $("#page-label").textContent = `${current} / ${info.pageCount} · ${zoom}%`;
  $("#previous").disabled = current <= 1;
  $("#next").disabled = current >= info.pageCount;
}
function anchor() {
  const top = $("nav").getBoundingClientRect().bottom;
  const area = $("#pages").getBoundingClientRect();
  let currentPage = pages.get(current),
    bestVisible = 0;
  // A previous-page footer can still touch the viewport while the next page
  // fills the reading area. Prefer that page instead of anchoring the footer.
  for (const page of orderedPages()) {
    const bounds = page.section.getBoundingClientRect();
    const visible = Math.min(bounds.bottom, innerHeight, top + 260) - Math.max(bounds.top, top);
    if (visible > bestVisible) {
      bestVisible = visible;
      currentPage = page;
    }
  }
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
      if (section === currentPage?.section) return saved;
      fallback ||= saved;
    }
  }
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
function sourceBoxes(page) {
  return [...page.content.querySelectorAll("[data-source-box]")].map((element) => ({
    element,
    box: element.dataset.sourceBox.split(",").map(Number),
  }));
}
const centerY = () => ($("nav").getBoundingClientRect().bottom + innerHeight) / 2;
function centerSource() {
  const x = innerWidth / 2,
    y = centerY();
  const page =
    orderedPages().find(({ section }) => {
      const rect = section.getBoundingClientRect();
      return rect.top <= y && rect.bottom > y;
    }) || pages.get(current);
  if (!page) return;
  const result = { page: page.page, glyph: -1, x: 0, y: 0 };
  let nearest,
    distance = Infinity;
  for (const item of sourceBoxes(page)) {
    const rect = item.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dx = Math.max(rect.left - x, x - rect.right, 0);
    const dy = Math.max(rect.top - y, y - rect.bottom, 0);
    if (dx * dx + dy * dy >= distance) continue;
    distance = dx * dx + dy * dy;
    nearest = item;
  }
  if (nearest) {
    const { box, element } = nearest,
      rect = element.getBoundingClientRect();
    result.x = box[0] + box[2] * Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    result.y = box[1] + box[3] * Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  }
  const caret = document.caretRangeFromPoint(x, y),
    node = caret?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE || !page.content.contains(node)) return result;
  let offset = Math.min(caret.startOffset, node.length - 1);
  if (offset < 0) return result;
  if (node.data.charCodeAt(offset) >= 0xdc00 && node.data.charCodeAt(offset) <= 0xdfff) offset--;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + (node.data.codePointAt(offset) > 0xffff ? 2 : 1));
  const rect = range.getBoundingClientRect();
  if (
    !range.toString().trim() ||
    rect.height <= 0 ||
    Math.max(rect.top - y, y - rect.bottom, rect.left - x, x - rect.right) > rect.height
  )
    return result;
  try {
    result.glyph = page.model.selection(range)[0]?.start ?? -1;
  } catch {}
  return result;
}
function restoreCenter(target) {
  const page = pages.get(target?.page);
  if (!page) return;
  const range = target.glyph >= 0 && page.model.domRanges(target.glyph, target.glyph + 1)[0];
  if (range) {
    const rect = range.getBoundingClientRect();
    scrollBy(0, rect.top + rect.height / 2 - centerY());
    return;
  }
  let nearest,
    distance = Infinity;
  for (const item of sourceBoxes(page)) {
    const [x, y, width, height] = item.box;
    const dx = Math.max(x - target.x, target.x - x - width, 0);
    const dy = Math.max(y - target.y, target.y - y - height, 0);
    const d = dx * dx + dy * dy;
    if (d > distance || (d === distance && nearest && nearest.box[2] * nearest.box[3] <= width * height)) continue;
    nearest = item;
    distance = d;
  }
  if (nearest) {
    const rect = nearest.element.getBoundingClientRect(),
      box = nearest.box;
    const fraction = Math.max(0, Math.min(1, (target.y - box[1]) / box[3]));
    scrollBy(0, rect.top + rect.height * fraction - centerY());
  }
}
function closeOriginal() {
  return call("close", centerSource() || {}).catch(error);
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
async function navigate(page, target, version = navigation) {
  if (!info || page < 1 || page > info.pageCount) return;
  clear();
  const token = epoch;
  navigation = version;
  navigating = true;
  $("#pages").setAttribute("aria-busy", "true");
  try {
    current = page;
    label();
    $("#status").textContent = say("正在重排当前页…", "Reflowing this page…");
    const entry = await load(page, token);
    if (!entry || token !== epoch) return;
    await call("position", { page, navigation: version });
    if (token !== epoch) return;
    $("#status").textContent = "";
    scrollTo(0, 0);
    // A bounded window only: opening a 2,000-page PDF never extracts the whole book.
    await Promise.all([load(page - 1, token), load(page + 1, token)]);
    if (token !== epoch) return;
    await Promise.all([...entry.content.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    if (token !== epoch) return;
    entry.section.scrollIntoView({ block: "start" });
    if (target) restoreCenter(target);
    positions();
  } finally {
    if (token === epoch) {
      navigating = false;
      $("#pages").setAttribute("aria-busy", "false");
    }
  }
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
  if (checking || navigating || !pages.size) return;
  checking = true;
  try {
    const ordered = orderedPages(),
      top = centerY();
    const at = ordered.find((p) => p.section.getBoundingClientRect().bottom > top);
    if (at && at.page !== current) {
      current = at.page;
      label();
      await call("position", { page: current, navigation });
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
  hideActions();
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
$("#original").addEventListener("click", closeOriginal);
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
  for (const { note, range } of allNoteRanges())
    for (const rect of range.getClientRects())
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { note, rect };
}
function hideActions() {
  clearTimeout(actionHideTimer);
  actionHideTimer = null;
  $("#note-actions").hidden = true;
  selectedNote = null;
  actionAnchor = null;
}
function showActions(hit, x, y, focus = false) {
  clearTimeout(actionHideTimer);
  actionHideTimer = null;
  const { note, rect } = hit,
    box = $("#note-actions"),
    changed = selectedNote?.id !== note.id || box.hidden;
  selectedNote = note;
  $("#note-ipa").textContent = note.ipa || "";
  if (changed) {
    actionAnchor = rect;
    box.hidden = false;
    box.style.left = `${Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - box.offsetHeight - 8))}px`;
  }
  if (focus) call("focus", { id: note.id }).catch(error);
}
function nearActions(x, y) {
  const box = $("#note-actions");
  if (box.hidden || !actionAnchor) return false;
  const bounds = box.getBoundingClientRect(),
    gap = 6;
  return (
    x >= Math.min(bounds.left, actionAnchor.left) - gap &&
    x <= Math.max(bounds.right, actionAnchor.right) + gap &&
    y >= Math.min(bounds.top, actionAnchor.top) - gap &&
    y <= Math.max(bounds.bottom, actionAnchor.bottom) + gap
  );
}
$("#speak-note").addEventListener("click", () => selectedNote && call("speak", { id: selectedNote.id }).catch(error));
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
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  if (e.buttons || !getSelection()?.isCollapsed) {
    hideActions();
    return;
  }
  const hit = e.target.closest("#pages") ? noteAtPoint(e.clientX, e.clientY) : null;
  $("#pages").title = hit?.note.ipa || "";
  $("#pages").style.cursor = hit ? "pointer" : "";
  if (hit) {
    showActions(hit, e.clientX, e.clientY);
    return;
  }
  if (e.target.closest("#note-actions") || nearActions(e.clientX, e.clientY)) {
    clearTimeout(actionHideTimer);
    actionHideTimer = null;
    return;
  }
  if (selectedNote && !actionHideTimer) actionHideTimer = setTimeout(hideActions, 120);
});
document.addEventListener("pointerleave", hideActions);
$("#pages").addEventListener("click", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.detail > 1 || !getSelection()?.isCollapsed) return;
  const hit = noteAtPoint(e.clientX, e.clientY);
  if (hit) {
    showActions(hit, e.clientX, e.clientY, true);
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
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "0"].includes(e.key)) {
    e.preventDefault();
    setZoom(e.key === "0" ? 100 : zoom * (e.key === "-" ? 1 / 1.1 : 1.1));
  }
});
addEventListener(
  "wheel",
  (e) => {
    clearTimeout(clickTimer);
    if (e.ctrlKey || e.metaKey) {
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
addEventListener("blur", () => {
  clearTimeout(clickTimer);
  hideActions();
});
addEventListener("resize", () => {
  hideActions();
  drawNotes();
});
addEventListener("reflowstate", (e) => {
  const state = e.detail;
  notes = state.highlights || [];
  if (selectedNote && !notes.some((note) => note.id === selectedNote.id)) hideActions();
  clickEnabled = state.click !== false;
  drawNotes();
});
addEventListener("reflowzoom", (e) => setZoom(e.detail.zoom, false));
addEventListener("reflownavigate", (e) => navigate(e.detail.page, e.detail.center, e.detail.navigation).catch(error));
addEventListener("reflowcapture", closeOriginal);
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
  await navigate(info.page || 1, info.center, info.navigation || 0);
} catch (e) {
  error(e);
}
