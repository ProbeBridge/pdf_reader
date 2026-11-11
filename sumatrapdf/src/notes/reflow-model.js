const allowed = new Set(
  "div span p h1 h2 h3 h4 h5 h6 b strong i em u s sup sub tt table thead tbody tfoot tr td th colgroup col caption ul ol li blockquote pre code br hr img".split(
    " ",
  ),
);

// PDF text and markup never become executable content or document navigation.
export function safeReflowContent(html, owner = document) {
  const parsed = new DOMParser().parseFromString(html, "text/html"),
    fragment = owner.createDocumentFragment();
  function copy(from, to) {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.append(owner.createTextNode(child.data));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName.toLowerCase();
      if (["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button"].includes(tag))
        continue;
      if (!allowed.has(tag)) {
        copy(child, to);
        continue;
      }
      const element = owner.createElement(tag);
      if (tag === "img") {
        const src = child.getAttribute("src") || "";
        if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(src)) continue;
        element.src = src;
        element.alt = "";
        const width = Number(child.getAttribute("width"));
        if (width > 0 && width <= 100000) element.style.setProperty("--image-width", `${width}px`);
      }
      if (tag === "td" || tag === "th")
        for (const key of ["rowspan", "colspan"]) {
          const value = Number(child.getAttribute(key));
          if (Number.isInteger(value) && value > 0 && value <= 1000) element.setAttribute(key, String(value));
        }
      copy(child, element);
      to.append(element);
    }
  }
  copy(parsed.body, fragment);
  return fragment;
}

function normalized(text) {
  const original = Array.from(text),
    chars = [],
    indices = [],
    positions = [],
    utf16 = new Map();
  let offset = 0;
  for (let i = 0; i < original.length; i++) {
    const char = /\s/u.test(original[i]) ? " " : original[i];
    if (char === "\u00ad") {
      positions[i] = Math.max(0, chars.length - 1);
      continue;
    }
    if (char === " " && chars.at(-1) === " ") {
      positions[i] = chars.length - 1;
      continue;
    }
    positions[i] = chars.length;
    utf16.set(offset, chars.length);
    offset += char.length;
    chars.push(char);
    indices.push(i);
  }
  utf16.set(offset, chars.length);
  return { text: chars.join(""), chars, original, indices, positions, utf16 };
}

export class SourcePage {
  constructor(root, page, sourceText, displayText) {
    this.root = root;
    this.page = page;
    this.sourceText = sourceText;
    this.displayText = displayText || sourceText;
    if (Array.from(this.displayText).length !== Array.from(sourceText).length)
      throw new Error("Reflow display text must preserve the source codepoint count.");
    this.bindings = new Map();
    const source = normalized(this.displayText),
      units = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      if (!node.data.trim()) continue;
      const unit = node.parentElement.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote") || node;
      if (!units.includes(unit)) units.push(unit);
    }
    for (const unit of units) {
      const nodes = unit.nodeType === Node.TEXT_NODE ? [unit] : [];
      if (!nodes.length) {
        const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) nodes.push(node);
      }
      const target = normalized(nodes.map((n) => n.data).join("")),
        needle = target.text.trim();
      if (!needle) continue;
      const trim = target.text.indexOf(needle);
      const found = source.text.indexOf(needle);
      if (found < 0) continue;
      // Table detection can reorder PDF text from columns into rows. An
      // ambiguous repeated cell/paragraph has no safe source-only anchor;
      // leave it unbound instead of silently annotating another occurrence.
      if (source.text.indexOf(needle, found + 1) >= 0) continue;
      const start = source.utf16.get(found),
        lead = target.utf16.get(trim) || 0,
        length = Array.from(needle).length;
      if (start === undefined) continue;
      let position = 0;
      for (const node of nodes) {
        const chars = Array.from(node.data),
          map = [];
        for (let i = 0; i < chars.length; i++) {
          const index = target.positions[position + i] - lead + start;
          map.push(index >= start && index < start + length ? source.indices[index] : undefined);
        }
        this.bindings.set(node, { chars, map });
        position += chars.length;
      }
    }
  }
  selection(range) {
    const glyphs = [];
    for (const [node, binding] of this.bindings) {
      if (!range.intersectsNode(node)) continue;
      if (range.comparePoint(node, 0) > 0 || range.comparePoint(node, node.length) < 0) continue;
      const first = node === range.startContainer ? Array.from(node.data.slice(0, range.startOffset)).length : 0;
      const end =
        node === range.endContainer ? Array.from(node.data.slice(0, range.endOffset)).length : binding.chars.length;
      for (let i = first; i < end; i++) {
        if (binding.map[i] === undefined && binding.chars[i].trim())
          throw new Error(
            "无法将这段文字定位到原文，请切换原版后注释。 / Select this text in the original view to annotate it.",
          );
        if (binding.map[i] !== undefined) glyphs.push(binding.map[i]);
      }
    }
    // Any visible text not represented by the source must never receive a guessed anchor.
    const all = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    for (let node; (node = all.nextNode());)
      if (node.data.trim() && range.intersectsNode(node) && !this.bindings.has(node)) {
        throw new Error(
          "无法将这段文字定位到原文，请切换原版后注释。 / Select this text in the original view to annotate it.",
        );
      }
    glyphs.sort((a, b) => a - b);
    const ranges = [],
      source = Array.from(this.displayText);
    for (const glyph of glyphs) {
      const previous = ranges.at(-1);
      if (previous && (glyph <= previous.end || source.slice(previous.end, glyph).every((c) => /\s/u.test(c))))
        previous.end = Math.max(previous.end, glyph + 1);
      else ranges.push({ page: this.page, start: glyph, end: glyph + 1 });
    }
    return ranges;
  }
  domRanges(start, end) {
    const ranges = [];
    for (const [node, binding] of this.bindings) {
      let run = -1,
        offset = 0,
        first = 0;
      for (let i = 0; i <= binding.chars.length; i++) {
        const glyph = binding.map[i],
          inside = glyph !== undefined && glyph >= start && glyph < end;
        if (inside && run < 0) {
          run = i;
          first = offset;
        }
        if (!inside && run >= 0) {
          const range = document.createRange();
          range.setStart(node, first);
          range.setEnd(node, offset);
          ranges.push(range);
          run = -1;
        }
        offset += binding.chars[i]?.length || 0;
      }
    }
    return ranges;
  }
}
