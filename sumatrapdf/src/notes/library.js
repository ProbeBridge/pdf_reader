import { native, node, button, text, toast, showError } from "./bridge.js";
import { libraryKey, libraryEntries } from "./library-model.js";

export function createLibrary(container) {
  let records = [],
    query = "",
    pending,
    dirty = true,
    adding = false;
  const heading = node("div", "heading library-heading"),
    title = node("div"),
    count = node("span", "library-count"),
    add = button(text("添加本地书", "Add local books"), pick, "library-add");
  add.id = "add-books";
  title.append(node("h2", "", text("书库", "Library")), count);
  heading.append(title, add);
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
    grid.replaceChildren();
    for (const entry of entries) {
      const { book, missing } = entry,
        card = node("article", "book-card");
      card.dataset.key = entry.key;
      const cover = button(book.name.split(".").at(-1).slice(0, 5).toUpperCase(), () => open(book), "book-cover");
      cover.setAttribute("aria-label", text(`打开 ${book.name}`, `Open ${book.name}`));
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
      card.append(cover, name, path, status, remove);
      grid.append(card);
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
    if (Object.keys(event.detail || {}).some((key) => key.startsWith("library:"))) refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (dirty) refresh();
  });
  render();
  return {
    refresh,
    setQuery(value) {
      query = value;
      render();
    },
  };
}
