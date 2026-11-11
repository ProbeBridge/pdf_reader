// Answer format of the first note on a selection:
//
//   IPA: /…/          (only for short Latin-script selections, when IPA is on)
//
//   short Chinese equivalent
//
//   【详解】
//   longer explanation (shown folded in the side panel)
//
// The format rules are appended to the (possibly user-edited) note prompt, so custom prompts keep
// working, and parseNote() splits a finished or still-streaming answer back into its parts.

const MAX_WORDS = 6;
export const DETAIL_MARK = '【详解】';

const ACCENTS = {
  us: '美式发音（General American）',
  uk: '英式发音（RP）',
};

/** A word, phrase or name rather than a sentence. */
export function isShortQuote(quote) {
  const q = String(quote || '').trim();
  return q.length <= 60 && q.split(/\s+/).length <= MAX_WORDS;
}

/** Only short Latin-script selections get an IPA line. */
export function wantsIpa(settings, quote) {
  if (!ACCENTS[settings.ipa]) return false;
  return /[A-Za-zÀ-ɏ]/.test(String(quote || '')) && isShortQuote(quote);
}

// Unit symbols as read aloud (datasheets): the model is told the word, so its IPA can't drift to a
// look-alike (mA read as "milligram", mW as "milliampere").
const UNIT_PREFIX = { p: 'pico', n: 'nano', µ: 'micro', μ: 'micro', u: 'micro', m: 'milli', k: 'kilo', M: 'mega', G: 'giga' };
// unit -> [spoken, prefixes it takes ('' = also on its own)]; rare pairs that read as something
// else are left out ("Ms" is a title, "MA" a state or a degree).
const UNIT = {
  A: ['amp', 'pnµμumk'], V: ['volt', 'µμumk'], W: ['watt', 'µμumkMG'], Ω: ['ohm', 'mkM', ''],
  F: ['farad', 'pnµμum'], H: ['henry', 'nµμum'], Hz: ['hertz', 'kMG', ''], s: ['second', 'pnµμum'],
  Wh: ['watt-hour', 'mkMG', ''], Ah: ['amp-hour', 'm', ''], VA: ['volt-amp', 'kM', ''], J: ['joule', 'µμumk'],
};

/** "mW" -> "milliwatt", "10-kΩ" -> "kilohm"; null for anything that isn't clearly a unit. */
export function spokenUnit(quote) {
  const m = /^(?:[\d.,]+\s*-?\s*)?([pnµμumkMG]?)(Hz|Wh|Ah|VA|[AVWΩFHsJ])$/.exec(String(quote || '').trim());
  const unit = m && UNIT[m[2]];
  if (!unit || (m[1] ? !unit[1].includes(m[1]) : unit[2] !== '')) return null;
  const prefix = UNIT_PREFIX[m[1]] || '';
  return prefix.endsWith('o') && unit[0].startsWith('o') ? prefix + unit[0].slice(1) : prefix + unit[0]; // kilo + ohm -> kilohm
}

export function formatInstruction(settings, quote) {
  const ipa = wantsIpa(settings, quote);
  const steps = [];
  if (ipa) {
    const unit = spokenUnit(quote);
    steps.push(
      `第一行只写选中内容的国际音标，格式为「IPA: /…/」，用${ACCENTS[settings.ipa]}，并按它在这段话里的实际读法标注（例如 read 的过去式、live 作形容词、重音随词性变化的词）；多个词逐词标注、用空格分隔。` +
        '缩写和符号（注意大小写）先写出它在这里读出来的完整英文、再写音标，例如 e.g. 写「IPA: for example /fɚ ɪɡˈzæmpəl/」；逐个字母读的缩略词直接标音，例如 USB 写「IPA: /ˌjuˌɛsˈbi/」。' +
        (unit ? `这里的「${String(quote).trim()}」是单位，读作 ${unit}，第一行写「IPA: ${unit} /…/」。` : '') +
        '音标必须和第一部分的中文是同一个词的读音。然后空一行。',
    );
  }
  steps.push('写第一部分：简短的中文对应词（选中的是句子就写译文），只写这一段，不加任何前缀或格式。');
  steps.push(`空一行，单独一行只写「${DETAIL_MARK}」，下一行开始写第二部分：详细解释。`);
  return `输出格式（严格遵守）：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${ipa ? '\n音标只在第一行出现，后面不要重复。' : ''}`;
}

const IPA_LEAD = /^\s*(?:\*\*)?\s*IPA\s*(?:\*\*)?\s*[:：]\s*/i;
// 【详解】, also tolerating **【详解】**, ### 【详解】, [详解], 【详细解释】：
const MARK = /[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*[【[][ \t]*详(?:细)?解(?:释)?[ \t]*[】\]](?:\*\*)?[ \t]*[:：]?/;
// While streaming: the start of a marker that has not fully arrived yet.
const MARK_START = /[【[][ \t]*(?:详(?:细)?(?:解(?:释)?)?)?$/;
const LINE_START = /\n[ \t]*(?:#{1,6}|\*{1,2})?[ \t]*$/;

/**
 * Split an answer into { ipa, note, detail, inDetail }. With `partial` (still streaming), characters
 * that may be the start of "IPA:" or of the 【详解】 marker are held back instead of shown.
 */
export function parseNote(text, partial = false) {
  let src = String(text || '');
  let ipa = '';
  const m = IPA_LEAD.exec(src);
  if (m) {
    const rest = src.slice(m[0].length);
    const nl = rest.indexOf('\n');
    ipa = (nl === -1 ? rest : rest.slice(0, nl)).replace(/\*\*|`/g, '').trim().slice(0, 160);
    if (nl === -1) return { ipa, note: '', detail: '', inDetail: false };
    src = rest.slice(nl + 1);
  } else if (partial && src.trim().length < 5 && /^\s*(?:\*\*?)?\s*I?P?A?$/i.test(src)) {
    return { ipa: '', note: '', detail: '', inDetail: false };
  }

  const d = MARK.exec(src);
  if (d) {
    return { ipa, note: src.slice(0, d.index).trim(), detail: src.slice(d.index + d[0].length).trim(), inDetail: true };
  }
  if (partial) src = src.replace(MARK_START, '').replace(LINE_START, '');
  return { ipa, note: src.trim(), detail: '', inDetail: false };
}

/** The whole first answer as the model wrote it (minus the IPA line), for follow-up context. */
export function noteForContext(ann) {
  return [ann.note, ann.detail ? `${DETAIL_MARK}\n${ann.detail}` : ''].filter(Boolean).join('\n\n');
}
