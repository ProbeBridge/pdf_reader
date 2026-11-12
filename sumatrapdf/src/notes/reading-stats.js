import { native, node, text, showError } from "./bridge.js";
import { readingSummary } from "./reading-stats-model.js";

const dateLabel = (day) =>
  new Intl.DateTimeFormat(navigator.language, { month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00`));
const duration = (seconds) =>
  seconds >= 3600
    ? text(
        `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`,
        `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`,
      )
    : seconds >= 60
      ? text(`${Math.floor(seconds / 60)} 分钟`, `${Math.floor(seconds / 60)}m`)
      : text(`${seconds} 秒`, `${seconds}s`);

export function createReadingStats(container) {
  let records = {},
    pending,
    again = false;
  const heading = node("div", "stats-heading");
  heading.append(node("h2", "", text("阅读统计", "Reading statistics")));
  const label = node("label", "stats-range", text("统计范围", "Period"));
  const range = node("select");
  range.id = "stats-range";
  for (const days of [7, 14, 30, 90]) {
    const option = node("option", "", text(`最近 ${days} 天`, `Last ${days} days`));
    option.value = String(days);
    option.selected = days === 14;
    range.append(option);
  }
  label.append(range);
  heading.append(label);
  const cards = node("div", "stats-cards"),
    chart = node("section", "stats-chart"),
    table = node("table", "stats-table");
  const caption = node("p", "stats-caption");
  container.append(
    heading,
    cards,
    chart,
    caption,
    table,
    node(
      "p",
      "stats-explanation",
      text(
        "从本版本开始记录。同一文档同一页每天只计一次，停留至少 2 秒后计入。仅前台阅读计时，连续 5 分钟未翻页或滚动时暂停。每条新建生词标注计一次，重新生成、追问、恢复或删除不改变历史计数。数据保存在本机。",
        "Recorded from this version onward. Each document page counts once a day after 2 seconds. Reading time counts in the foreground and pauses after 5 minutes without scrolling or changing pages. Each new vocabulary note counts once; regeneration, follow-ups, restoration and deletion do not change past totals. Stored locally.",
      ),
    ),
  );
  function render() {
    const summary = readingSummary(records, range.value);
    cards.replaceChildren();
    for (const [key, title, value] of [
      ["pages", text("今日阅读页数", "Pages read today"), summary.today.pages],
      ["words", text("今日生词标注", "Vocabulary notes today"), summary.today.words],
      ["time", text("今日阅读时长", "Reading time today"), duration(summary.today.seconds)],
    ]) {
      const card = node("section", "stat-card");
      card.append(node("h3", "", title));
      const number = node("strong", "", value);
      number.dataset.stat = key;
      card.append(number);
      cards.append(card);
    }
    const legend = node("div", "stats-legend");
    legend.append(
      node("span", "reading-legend", text("阅读页数", "Pages read")),
      node("span", "words-legend", text("生词标注", "Vocabulary notes")),
    );
    const bars = node("div", "stats-bars");
    bars.style.setProperty("--days", summary.days.length);
    bars.setAttribute("aria-hidden", "true");
    const maximum = Math.max(1, ...summary.days.flatMap((day) => [day.pages, day.words]));
    for (const day of summary.days) {
      const pair = node("div", "stats-pair");
      pair.title = `${dateLabel(day.day)} · ${text("阅读", "Pages")} ${day.pages} · ${text("生词", "Notes")} ${day.words}`;
      for (const [className, amount] of [
        ["reading-bar", day.pages],
        ["words-bar", day.words],
      ]) {
        const bar = node("span", className);
        bar.style.height = `${(100 * amount) / maximum}%`;
        pair.append(bar);
      }
      bars.append(pair);
    }
    const axis = node("div", "stats-axis");
    axis.append(node("span", "", dateLabel(summary.days[0].day)), node("span", "", text("今天", "Today")));
    chart.replaceChildren(legend, bars, axis);
    caption.textContent = text(
      `所选期间共阅读 ${summary.totals.pages} 页，新增 ${summary.totals.words} 条生词标注，阅读 ${duration(summary.totals.seconds)}。`,
      `Period total: ${summary.totals.pages} pages, ${summary.totals.words} vocabulary notes, ${duration(summary.totals.seconds)}.`,
    );
    const tableCaption = node("caption", "", text("每日明细", "Daily totals"));
    const head = node("thead"),
      row = node("tr");
    for (const title of [
      text("日期", "Date"),
      text("阅读页数", "Pages"),
      text("生词标注", "Vocabulary notes"),
      text("阅读时长", "Reading time"),
    ]) {
      const cell = node("th", "", title);
      cell.scope = "col";
      row.append(cell);
    }
    head.append(row);
    const body = node("tbody");
    for (const day of [...summary.days].reverse()) {
      const row = node("tr"),
        date = node("th", "", dateLabel(day.day));
      date.scope = "row";
      row.append(date, node("td", "", day.pages), node("td", "", day.words), node("td", "", duration(day.seconds)));
      body.append(row);
    }
    table.replaceChildren(tableCaption, head, body);
  }
  function refresh() {
    if (container.hidden || document.hidden) return Promise.resolve();
    again = true;
    if (pending) return pending;
    container.setAttribute("aria-busy", "true");
    pending = (async () => {
      while (again && !container.hidden && !document.hidden) {
        again = false;
        records = await native("readingStats");
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
  range.addEventListener("change", render);
  window.addEventListener("storechange", (event) => {
    if (Object.keys(event.detail || {}).some((key) => key.startsWith("stats:"))) refresh();
  });
  document.addEventListener("visibilitychange", refresh);
  render();
  return { refresh };
}
