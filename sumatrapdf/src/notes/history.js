import { native, node, button, text, toast, showError, zh } from "./bridge.js";
import { dayKey, historyGroups } from "./history-model.js";
import { createReadingStats } from "./reading-stats.js";
const $ = (s) => document.querySelector(s);
let entries = [];
let statsVisible = false;
const statsView = createReadingStats($("#stats-panel"));
function showStats(visible) {
  statsVisible = visible;
  $("aside h1").textContent = visible ? text("阅读统计", "Reading statistics") : text("阅读历史", "Reading history");
  $("aside p").textContent = visible
    ? text("页数、注释数与阅读时间", "Pages, annotations and reading time")
    : text("按时间浏览读过的文档", "Documents you have opened");
  $("#history-panel").hidden = visible;
  $("#stats-panel").hidden = !visible;
  $(".search").hidden = visible;
  $("#statistics").textContent = visible ? text("阅读历史", "Reading history") : text("阅读统计", "Statistics");
  for (const [id, selected] of [
    ["statistics", visible],
    ["stats-tab", visible],
    ["history-tab", !visible],
  ]) {
    $("#" + id).setAttribute("aria-pressed", String(selected));
    if (id !== "statistics") $("#" + id).classList.toggle("selected", selected);
  }
  if (visible) statsView.refresh();
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
$("#search").addEventListener("input", render);
$("#open").addEventListener("click", () => native("openPicker").catch(showError));
$("#notes").addEventListener("click", () => native("showNotes").catch(showError));
$("#statistics").addEventListener("click", () => showStats(!statsVisible));
$("#history-tab").addEventListener("click", () => showStats(false));
$("#stats-tab").addEventListener("click", () => showStats(true));
document.addEventListener("keydown", (e) => {
  if (statsVisible) return;
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
