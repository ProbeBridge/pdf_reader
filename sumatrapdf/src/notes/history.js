import { native, node, button, text, toast, showError, zh } from "./bridge.js";
import { dayKey, historyGroups } from "./history-model.js";
import { createReadingStats } from "./reading-stats.js";
import { createLibrary } from "./library.js";
const $ = (s) => document.querySelector(s);
let entries = [];
let currentView = "history";
const queries = { history: "", library: "" };
const statsView = createReadingStats($("#stats-panel"));
const libraryView = createLibrary($("#library-panel"));
function showView(view) {
  if (currentView !== "stats") queries[currentView] = $("#search").value;
  currentView = view;
  const titles = {
    history: text("阅读历史", "Reading history"),
    library: text("书库", "Library"),
    stats: text("阅读统计", "Reading statistics"),
  };
  $("aside h1").textContent = titles[view];
  $("aside p").textContent = {
    history: text("按时间浏览读过的文档", "Documents you have opened"),
    library: text("收藏本机的书籍与文档", "Your local books and documents"),
    stats: text("页数、注释数与阅读时间", "Pages, annotations and reading time"),
  }[view];
  for (const name of ["history", "library", "stats"]) {
    $("#" + name + "-panel").hidden = view !== name;
    $("#" + name + "-tab").classList.toggle("selected", view === name);
    $("#" + name + "-tab").setAttribute("aria-pressed", String(view === name));
  }
  $(".search").hidden = view === "stats";
  $("#search").value = queries[view] || "";
  $("#search").placeholder =
    view === "library" ? text("搜索书库", "Search library") : text("搜索阅读历史", "Search reading history");
  $("#search").setAttribute("aria-label", $("#search").placeholder);
  $("#statistics").textContent =
    view === "stats" ? text("阅读历史", "Reading history") : text("阅读统计", "Statistics");
  $("#statistics").setAttribute("aria-pressed", String(view === "stats"));
  $("#library").setAttribute("aria-pressed", String(view === "library"));
  if (view === "stats") statsView.refresh();
  if (view === "library") {
    libraryView.setQuery(queries.library);
    libraryView.refresh();
  }
  if (view === "history") render();
}
let refreshNeeded = false,
  refreshPromise;
const dateFormat = new Intl.DateTimeFormat(navigator.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }),
  timeFormat = new Intl.DateTimeFormat(navigator.language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
if (!zh) {
  $("h1").textContent = $("#heading").textContent = "Reading history";
  $("aside p").textContent = "Documents you have opened";
  $("#history-tab").textContent = "◷　Reading history";
  $("#stats-tab").textContent = "▥　Statistics";
  $("#library-tab").textContent = "▤　Library";
  $("#library").textContent = "Library";
  $("#statistics").textContent = "Statistics";
  $(".aside-hint").textContent = "Stored on this computer. Removing a record keeps the file.";
  $("#search").placeholder = "Search reading history";
  $("#open").textContent = "Open file";
  $("#notes").textContent = "AI notes";
}
function render() {
  const groups = historyGroups(entries, $("#search").value);
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  $("#count").textContent = text(`${total} 份文档`, `${total} documents`);
  const sections = document.createDocumentFragment();
  $("#empty").hidden = total > 0;
  $("#empty").textContent = $("#search").value
    ? text("没有匹配的阅读记录", "No matching documents")
    : text("还没有阅读记录。打开一份文档，开始阅读。", "No history yet. Open a document to start reading.");
  const today = dayKey(Date.now()),
    yesterday = dayKey(new Date().setDate(new Date().getDate() - 1));
  for (const { day, files } of groups) {
    const group = node("section", "group");
    let label = day
      ? dateFormat.format(new Date(Number(files[0].opened)))
      : text("较早记录 · 未记录时间", "Earlier · time not recorded");
    if (day === today) label = `${text("今天", "Today")} · ${label}`;
    if (day === yesterday) label = `${text("昨天", "Yesterday")} · ${label}`;
    group.append(node("h3", "", label));
    for (const file of files) {
      const row = node("div", "row");
      row.append(node("time", "time", file.opened ? timeFormat.format(new Date(Number(file.opened))) : "—"));
      row.append(node("span", "file-icon", file.name.split(".").at(-1).slice(0, 4).toUpperCase()));
      const name = node("div", "file");
      name.append(
        button(file.name, () => native("open", { path: file.path })),
        node("span", "path", file.path),
      );
      name.title = file.path;
      const remove = button(
        "×",
        async () => {
          await native("hideHistory", { path: file.path });
          entries = entries.filter((e) => e.path !== file.path);
          render();
          toast(text("已移除记录", "Record removed"), async () => {
            await native("restoreHistory", { path: file.path });
            await refresh();
          });
        },
        "remove",
      );
      remove.title = text("从历史记录中移除", "Remove from history");
      remove.setAttribute("aria-label", `${remove.title}: ${file.name}`);
      row.append(name, remove);
      group.append(row);
    }
    sections.append(group);
  }
  $("#groups").replaceChildren(sections);
}
function refresh() {
  refreshNeeded = true;
  if (document.hidden) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  refreshPromise = Promise.resolve()
    .then(async () => {
      while (refreshNeeded && !document.hidden) {
        refreshNeeded = false;
        entries = await native("history");
        if (document.hidden) {
          refreshNeeded = true;
          break;
        }
        if (!refreshNeeded) render();
      }
    })
    .catch((error) => {
      refreshNeeded = false;
      throw error;
    })
    .finally(() => {
      refreshPromise = undefined;
      if (refreshNeeded && !document.hidden) return refresh();
    });
  return refreshPromise;
}
$("#search").addEventListener("input", () => {
  queries[currentView] = $("#search").value;
  if (currentView === "library") libraryView.setQuery(queries.library);
  else render();
});
$("#open").addEventListener("click", () => native("openPicker").catch(showError));
$("#notes").addEventListener("click", () => native("showNotes").catch(showError));
$("#statistics").addEventListener("click", () => showView(currentView === "stats" ? "history" : "stats"));
$("#history-tab").addEventListener("click", () => showView("history"));
$("#stats-tab").addEventListener("click", () => showView("stats"));
$("#library").addEventListener("click", () => showView("library"));
$("#library-tab").addEventListener("click", () => showView("library"));
document.addEventListener("keydown", (e) => {
  if (currentView === "stats") return;
  if (((e.ctrlKey || e.metaKey) && ["f", "h"].includes(e.key.toLowerCase())) || e.key === "/") {
    e.preventDefault();
    $("#search").focus();
  }
});
window.addEventListener("historychange", () => refresh().catch(showError));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && refreshNeeded) refresh().catch(showError);
});
await refresh();
