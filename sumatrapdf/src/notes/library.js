import { native, node, button, text, toast, showError } from "./bridge.js";
import { libraryKey, libraryEntries } from "./library-model.js";

export function createLibrary(container) {
  let records = [],
    query = "",
    pending,
    dirty = true,
    adding = false,
    view = "grid",
    viewLoaded = false,
    coverQueue = [],
    activeCovers = 0;
  const coverCache = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        coverQueue.push(entry.target);
      }
      loadCovers();
    },
    { rootMargin: "160px" },
  );
  const heading = node("div", "heading library-heading"),
    title = node("div"),
    count = node("span", "library-count"),
    add = button(text("添加本地书", "Add local books"), pick, "library-add"),
    actions = node("div", "library-actions"),
    views = node("div", "library-views"),
    gridView = button(text("网格", "Grid"), () => setView("grid")),
    listView = button(text("列表", "List"), () => setView("list"));
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", text("书库显示方式", "Library display"));
  gridView.id = "library-view-grid";
  listView.id = "library-view-list";
  views.append(gridView, listView);
  actions.append(views, add);
  add.id = "add-books";
  title.append(node("h2", "", text("书库", "Library")), count);
  heading.append(title, actions);
  const hint = node(
      "p",
      "library-hint",
      text(
        "添加 PDF、EPUB 等本地文档，文件保留在原位置。",
        "Add local PDFs, EPUBs and other documents. Files stay in their original location.",
      ),
    ),
    grid = node("div", "library-grid"),
    empty = node("div", "library-empty");
  grid.id = "books";
  empty.id = "library-empty";
  container.append(heading, hint, grid, empty);
  function applyView(mode) {
    view = mode === "list" ? "list" : "grid";
    grid.dataset.view = view;
    gridView.setAttribute("aria-pressed", String(view === "grid"));
    listView.setAttribute("aria-pressed", String(view === "list"));
  }
  async function setView(mode) {
    applyView(mode);
    await native("write", { key: "ui:library", value: JSON.stringify({ view }) });
  }
  function loadCovers() {
    while (activeCovers < 2 && coverQueue.length) {
      const cover = coverQueue.shift();
      if (!cover.isConnected || container.hidden || document.hidden) continue;
      const key = cover.dataset.coverKey;
      if (!coverCache.has(key)) {
        if (coverCache.size >= 96) coverCache.delete(coverCache.keys().next().value);
        coverCache.set(
          key,
          native("libraryCover", { path: cover.dataset.path }).catch(() => null),
        );
      }
      activeCovers++;
      coverCache
        .get(key)
        .then((result) => {
          if (!cover.isConnected || !result?.image?.startsWith("data:image/png;base64,")) return;
          const image = node("img");
          image.alt = "";
          image.decoding = "async";
          image.addEventListener(
            "load",
            () => {
              cover.replaceChildren(image);
              cover.classList.add("has-cover");
            },
            { once: true },
          );
          image.src = result.image;
        })
        .finally(() => {
          activeCovers--;
          loadCovers();
        });
    }
  }
  function render() {
    const entries = libraryEntries(records, query);
    count.textContent = text(`${entries.length} 本书`, `${entries.length} books`);
    empty.hidden = entries.length > 0;
    empty.textContent = query
      ? text("没有匹配的书籍", "No matching books")
      : text(
          "书库还是空的。点击“添加本地书”选择文档。",
          "Your library is empty. Choose “Add local books” to select documents.",
        );
    observer.disconnect();
    coverQueue = [];
    grid.replaceChildren();
    for (const entry of entries) {
      const { book, missing } = entry,
        card = node("article", "book-card");
      card.dataset.key = entry.key;
      const cover = button(book.name.split(".").at(-1).slice(0, 5).toUpperCase(), () => open(book), "book-cover");
      cover.setAttribute("aria-label", text(`打开 ${book.name}`, `Open ${book.name}`));
      cover.dataset.path = book.path;
      cover.dataset.coverKey = JSON.stringify([book.path, entry.version || ""]);
      const name = button(book.name, () => open(book), "book-title");
      name.title = book.name;
      const path = node("p", "book-path", book.path);
      path.title = book.path;
      const status = node(
        "span",
        "book-status",
        missing ? text("文件已移动或不存在", "File moved or unavailable") : "",
      );
      status.hidden = !missing;
      const remove = button("×", () => removeBook(entry), "book-remove");
      remove.title = text("移出书库", "Remove from library");
      remove.setAttribute("aria-label", `${remove.title}: ${book.name}`);
      const details = node("div", "book-details");
      details.append(name, path, status);
      if (entry.shared) details.append(node("span", "book-shared", text("共享书库", "Shared library")));
      card.append(cover, details);
      if (!entry.shared) card.append(remove);
      grid.append(card);
      if (!missing) observer.observe(cover);
    }
  }
  async function open(book) {
    await native("open", { path: book.path });
  }
  async function removeBook(entry) {
    await native("remove", { key: entry.key });
    records = records.filter((record) => record.key !== entry.key);
    render();
    toast(text("已移出书库，原文件保留", "Removed from library; the file is kept"), async () => {
      await native("write", { key: entry.key, value: JSON.stringify(entry.book), expected: "null" });
      await refresh();
    });
  }
  async function pick() {
    if (adding) return;
    adding = add.disabled = true;
    try {
      const files = await native("libraryPicker");
      if (!Array.isArray(files) || !files.length) return;
      let added = 0;
      for (const file of files) {
        const book = { path: file.path, name: file.name, addedAt: Date.now() };
        const result = await native("write", {
          key: libraryKey(book.path),
          value: JSON.stringify(book),
          expected: "null",
        });
        if (!result?.conflict) added++;
      }
      toast(
        added
          ? text(`已添加 ${added} 本书`, `${added} books added`)
          : text("所选书籍已在书库中", "These books are already in your library"),
      );
    } finally {
      adding = add.disabled = false;
      await refresh();
    }
  }
  function refresh() {
    dirty = true;
    if (container.hidden || document.hidden || adding) return Promise.resolve();
    if (pending) return pending;
    container.setAttribute("aria-busy", "true");
    pending = (async () => {
      while (dirty && !container.hidden && !document.hidden) {
        dirty = false;
        if (!viewLoaded) {
          const stored = await native("read");
          applyView(stored?.["ui:library"]?.view);
          viewLoaded = true;
        }
        records = await native("library");
        render();
      }
    })()
      .catch(showError)
      .finally(() => {
        pending = null;
        container.removeAttribute("aria-busy");
      });
    return pending;
  }
  window.addEventListener("storechange", (event) => {
    if (event.detail?.["ui:library"]) applyView(event.detail["ui:library"].newValue?.view);
    if (Object.keys(event.detail || {}).some((key) => key.startsWith("library:"))) refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (dirty) refresh();
    if (!document.hidden) loadCovers();
  });
  applyView(view);
  render();
  return {
    refresh,
    setQuery(value) {
      query = value;
      render();
    },
  };
}
