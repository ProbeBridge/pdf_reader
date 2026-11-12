import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readingSummary } from "../sumatrapdf/src/notes/reading-stats-model.js";

const now = new Date("2026-11-12T12:00:00").getTime();
const data = {
  "stats:reading:a": {
    kind: "reading",
    day: "2026-11-12",
    document: "a",
    pages: [1, 2, 2, 0, -1, 4],
    pageCount: 3,
    seconds: 60,
  },
  "stats:reading:a-copy": {
    kind: "reading",
    day: "2026-11-12",
    document: "a",
    pages: [2, 3],
    pageCount: 3,
    seconds: 90,
  },
  "stats:reading:b": {
    kind: "reading",
    day: "2026-11-12",
    document: "b",
    pages: [1],
    seconds: 35,
  },
  "stats:words:today": {
    kind: "vocabulary",
    day: "2026-11-12",
    ids: ["one", "two", "two", ""],
  },
  "stats:words:copy": {
    kind: "vocabulary",
    day: "2026-11-12",
    ids: ["two", "three"],
  },
  "stats:reading:previous": {
    kind: "reading",
    day: "2026-11-11",
    document: "a",
    pages: [1, 1],
    seconds: 10,
  },
  "stats:words:previous": {
    kind: "vocabulary",
    day: "2026-11-11",
    ids: ["yesterday"],
  },
  "page:imported": { annotations: [{ id: "old-note", createdAt: now }] },
  "stats:words:future": {
    kind: "vocabulary",
    day: "2026-11-13",
    ids: ["future"],
  },
  "stats:words:old": { kind: "vocabulary", day: "2020-01-01", ids: ["old"] },
};
const summary = readingSummary(data, 7, now);
assert.deepEqual(summary.today, {
  day: "2026-11-12",
  pages: 4,
  words: 3,
  seconds: 125,
});
assert.deepEqual(summary.totals, { pages: 5, words: 4, seconds: 135 });
assert.equal(summary.days.length, 7);
assert.equal(summary.days[0].day, "2026-11-06");
assert.equal(summary.days[0].pages, 0);
assert.equal(
  summary.days[5].pages,
  1,
  "the same page counts again on another day",
);
assert.deepEqual(readingSummary({}, 14, now).totals, {
  pages: 0,
  words: 0,
  seconds: 0,
});
assert.equal(readingSummary(null, 100000, now).days.length, 90);
assert.equal(
  readingSummary(
    {
      "stats:bad": {
        kind: "reading",
        day: "2026-11-12",
        document: "bad",
        pages: "broken",
        seconds: -20,
      },
    },
    1,
    now,
  ).today.seconds,
  0,
);
for (const timezone of [
  "America/Los_Angeles",
  "Europe/Berlin",
  "Asia/Shanghai",
]) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { readingSummary } from './sumatrapdf/src/notes/reading-stats-model.js';
    for (const date of ['2026-03-10T12:00:00', '2026-11-03T12:00:00', '2024-03-02T12:00:00']) {
      const summary = readingSummary({}, 14, new Date(date).getTime());
      assert.equal(new Set(summary.days.map(day => day.day)).size, 14);
      assert.equal(summary.today.day, date.slice(0, 10));
    }
  `,
    ],
    { env: { ...process.env, TZ: timezone }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${timezone}: ${result.stderr}`);
}
console.log(
  "PASS: daily page/note deduplication, per-document totals, local midnight, empty days, imported notes, date ranges, DST and leap days.",
);
