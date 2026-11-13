import { native, node, text, showError } from "./bridge.js";
import { readingSeries } from "./reading-stats-model.js";

const dateLabel = (day, period) => {
  const date = new Date(`${day}T12:00:00`);
  if (period === "year") return String(date.getFullYear());
  return new Intl.DateTimeFormat(navigator.language, {
    year: "numeric",
    month: "short",
    ...(period === "month" ? {} : { day: "numeric" }),
  }).format(date);
};
const pointLabel = (point, period) =>
  period === "week"
    ? `${dateLabel(point.start, "day")} – ${dateLabel(point.end, "day")}`
    : dateLabel(point.start, period);
const duration = (seconds) =>
  seconds >= 3600
    ? text(
        `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`,
        `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`,
      )
    : seconds >= 60
      ? text(`${Math.floor(seconds / 60)} 分钟`, `${Math.floor(seconds / 60)}m`)
      : text(`${seconds} 秒`, `${seconds}s`);
const axisDuration = (seconds) =>
  seconds >= 60 && seconds % 60
    ? text(`${Math.floor(seconds / 60)}分${seconds % 60}秒`, `${Math.floor(seconds / 60)}m ${seconds % 60}s`)
    : duration(seconds);
const chartScale = (maximum) => {
  const step = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(1, maximum) / 4)));
  return Math.max(4, 4 * Math.ceil(maximum / 4 / step) * step);
};

export function createReadingStats(container) {
  let records = {},
    pending,
    again = false;
  const heading = node("div", "stats-heading");
  heading.append(node("h2", "", text("阅读统计", "Reading statistics")));
  const label = node("label", "stats-range", text("按", "Group by"));
  const range = node("select");
  range.id = "stats-range";
  range.setAttribute("aria-label", text("统计粒度", "Statistics interval"));
  for (const [value, title] of [
    ["day", text("日", "Day")],
    ["week", text("周", "Week")],
    ["month", text("月", "Month")],
    ["year", text("年", "Year")],
  ]) {
    const option = node("option", "", title);
    option.value = value;
    range.append(option);
  }
  label.append(range);
  heading.append(label);
  const cards = node("div", "stats-cards"),
    charts = node("div", "stats-charts"),
    table = node("table", "stats-table"),
    caption = node("p", "stats-caption");
  container.append(
    heading,
    cards,
    charts,
    caption,
    table,
    node(
      "p",
      "stats-explanation",
      text(
        "同一文档同一页每天只计一次，停留至少 2 秒后计入；周从周一开始。仅前台阅读计时，连续 5 分钟未翻页或滚动时暂停。每条新建注释计一次，重新生成、追问、恢复或删除不改变历史计数。数据保存在本机，从开始使用统计功能时记录。",
        "Each document page counts once a day after 2 seconds; weeks start on Monday. Reading time counts in the foreground and pauses after 5 minutes without scrolling or changing pages. Each new annotation counts once; regeneration, follow-ups, restoration and deletion do not change past totals. Stored locally from when statistics recording began.",
      ),
    ),
  );
  function render() {
    const summary = readingSeries(records, range.value),
      period = summary.period;
    const currentLabel = {
      day: text("今日", "today"),
      week: text("本周", "this week"),
      month: text("本月", "this month"),
      year: text("本年", "this year"),
    }[period];
    const windowLabel = {
      day: text("最近 14 天", "Last 14 days"),
      week: text("最近 12 周", "Last 12 weeks"),
      month: text("最近 12 个月", "Last 12 months"),
      year: text("最近 5 年", "Last 5 years"),
    }[period];
    const metrics = [
      { key: "pages", stat: "pages", title: text("阅读页数", "Pages read"), format: String },
      { key: "annotations", stat: "words", title: text("注释数", "Annotations"), format: String },
      { key: "seconds", stat: "time", title: text("阅读时间", "Reading time"), format: duration },
    ];
    cards.replaceChildren();
    charts.replaceChildren();
    for (const metric of metrics) {
      const card = node("section", "stat-card"),
        number = node("strong", "", metric.format(summary.current[metric.key]));
      number.dataset.stat = metric.stat;
      card.append(node("h3", "", text(`${currentLabel}${metric.title}`, `${metric.title} ${currentLabel}`)), number);
      cards.append(card);
    }
    const chart = node("section", "stats-chart"),
      chartHeading = node("div", "stats-chart-heading"),
      title = node("h3", "", text("阅读趋势", "Reading activity")),
      legend = node("div", "stats-legend"),
      countMax = chartScale(Math.max(...summary.points.flatMap((point) => [point.pages, point.annotations]))),
      timeMax = chartScale(Math.max(...summary.points.map((point) => point.seconds)));
    title.id = "stats-chart-title";
    chart.setAttribute("aria-labelledby", title.id);
    chartHeading.append(
      title,
      node(
        "span",
        "stats-scale",
        text("页数 / 注释数：左轴 · 时间：右轴", "Pages / annotations: left axis · time: right axis"),
      ),
    );
    for (const metric of metrics) {
      const item = node("span", "stats-legend-item", metric.title);
      item.dataset.metric = metric.key;
      legend.append(item);
    }
    const plot = node("div", "stats-plot"),
      left = node("div", "stats-y-axis"),
      right = node("div", "stats-y-axis stats-y-right"),
      bars = node("div", "stats-bars"),
      detail = node(
        "p",
        "stats-point-detail",
        text(
          "悬停或聚焦柱形，查看该时段的三项统计。",
          "Hover or focus a column to see all three values for that period.",
        ),
      );
    left.setAttribute("aria-hidden", "true");
    right.setAttribute("aria-hidden", "true");
    for (let tick = 4; tick >= 0; tick--) {
      left.append(node("span", "", String((countMax * tick) / 4)));
      right.append(node("span", "", axisDuration((timeMax * tick) / 4)));
    }
    bars.style.setProperty("--points", summary.points.length);
    for (const point of summary.points) {
      const column = node("button", "stats-point");
      column.type = "button";
      const description = `${pointLabel(point, period)} · ${metrics.map((metric) => `${metric.title}: ${metric.key === "seconds" ? axisDuration(point.seconds) : metric.format(point[metric.key])}`).join(" · ")}`;
      column.title = description;
      column.setAttribute("aria-label", description);
      column.addEventListener("mouseenter", () => {
        detail.textContent = description;
      });
      column.addEventListener("focus", () => {
        detail.textContent = description;
      });
      for (const metric of metrics) {
        const bar = node("span", "stats-bar");
        bar.dataset.metric = metric.key;
        bar.dataset.value = point[metric.key];
        bar.style.height = `${(100 * point[metric.key]) / (metric.key === "seconds" ? timeMax : countMax)}%`;
        column.append(bar);
      }
      bars.append(column);
    }
    plot.append(left, bars, right);
    const axis = node("div", "stats-axis");
    axis.append(
      node("span", "", dateLabel(summary.points[0].start, period)),
      node("span", "", dateLabel(summary.current.start, period)),
    );
    chart.append(chartHeading, legend, plot, axis, detail);
    charts.append(chart);
    caption.textContent = text(
      `${windowLabel}：共阅读 ${summary.totals.pages} 页，新增 ${summary.totals.annotations} 条注释，阅读 ${duration(summary.totals.seconds)}。`,
      `${windowLabel}: ${summary.totals.pages} pages, ${summary.totals.annotations} annotations, ${duration(summary.totals.seconds)}.`,
    );
    const tableCaption = node("caption", "", windowLabel),
      head = node("thead"),
      row = node("tr");
    for (const title of [text("日期", "Period"), ...metrics.map((metric) => metric.title)]) {
      const cell = node("th", "", title);
      cell.scope = "col";
      row.append(cell);
    }
    head.append(row);
    const body = node("tbody");
    for (const point of [...summary.points].reverse()) {
      const row = node("tr"),
        date = node("th", "", pointLabel(point, period));
      date.scope = "row";
      row.append(date, ...metrics.map((metric) => node("td", "", metric.format(point[metric.key]))));
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
