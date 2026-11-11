// Shared settings for the service worker, side panel and options page (ES module).
// The content script reads `settings.floatingButton` straight from storage instead.

// The first note on a selection: the Chinese equivalent, as short as possible, then a longer
// explanation that the side panel keeps folded until the reader opens it.
export const DEFAULT_SYSTEM_PROMPT = `你是陪读助手，帮助中文读者读网页上的文章（多为英文）。用户会给出选中内容所在的整段原文（<paragraph>）和被选中的部分（<selection>）。回答分两部分。

第一部分：选中内容在这段话里对应的中文，越短越好。
- 单词、短语、专有名词：只给出最贴切的中文词语，要符合它在这段话里的意思和语气（例如作者在反讽时，可以用“所谓的……”）。
- 只有中文里找不到对应的词时，才用一个简短的短语或一句话说明意思。
- 句子：只给出通顺的中文译文。
这一部分不要解释、不要复述原文，不要加“中文：”之类的前缀，也不要用 Markdown。

第二部分：详细解释。读者默认看不到，需要时才展开。结合这段话讲清楚它在这里的确切意思和语气（反讽、委婉、夸张等）、为什么这样译，以及值得注意的用法、搭配或语法结构；有典故或背景知识就简要交代。写得紧凑，一般 100～300 字；可以用 Markdown（加粗、列表），不要用标题，不要寒暄。`;

// Follow-up questions (including "解释这段") are not length-limited.
export const DEFAULT_FOLLOWUP_PROMPT = `你是陪读助手，帮助中文读者读懂网页上的文章。对话开头是用户选中内容所在的原文段落和选中内容，以及你给出的中文对应词和详细解释。
接下来用户会继续追问：请结合原文段落认真回答，可以详细解释含义、语气、反讽、典故、语法结构和用法，篇幅不限，讲清楚为止。
用简体中文，可以使用 Markdown（加粗、列表），不要用标题；不要重复前面已经讲过的内容。`;

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    // 'auto' = try the newest Flash models first and fall back when one is overloaded / rate-limited.
    models: ['auto', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-pro-latest'],
    defaultModel: 'auto',
  },
  anthropic: {
    label: 'Anthropic（Claude）',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-opus-5-5',
  },
  openai: {
    label: 'OpenAI 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    defaultModel: '',
  },
};

export const DEFAULT_SETTINGS = {
  provider: 'gemini',
  apiKey: '',
  baseUrl: '', // empty = provider default
  model: PROVIDERS.gemini.defaultModel,
  effort: 'low', // Anthropic effort / Gemini thinkingLevel: low | medium | high | default (don't send)
  systemPrompt: '', // empty = DEFAULT_SYSTEM_PROMPT (first note)
  followupPrompt: '', // empty = DEFAULT_FOLLOWUP_PROMPT (follow-up questions)
  ipa: 'us', // pronunciation shown for words/short phrases: us | uk | off
  floatingButton: true,
  clickToAnnotate: true, // click an English word in a page or PDF to annotate it
  panelZoom: 100, // side panel text size in %, changed from the panel itself (Ctrl/⌘ + - 0)
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
