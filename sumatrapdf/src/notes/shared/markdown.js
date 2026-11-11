// Tiny, safe Markdown subset for notes: paragraphs, lists, **bold**, *italic*, `code`.
// Everything is HTML-escaped first, so model output can never inject markup.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(text) {
  const out = [];
  let para = [];
  let list = null; // { tag, items }

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list?.tag !== 'ul') flushList();
      list ??= { tag: 'ul', items: [] };
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+(?:[.)]\s+|、\s*)(.*)$/.exec(line))) {
      flushPara();
      if (list?.tag !== 'ol') flushList();
      list ??= { tag: 'ol', items: [] };
      list.items.push(m[1]);
    } else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
      flushPara();
      flushList();
      out.push(`<p><strong>${inline(m[1])}</strong></p>`);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // continuation of a list item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('');
}
