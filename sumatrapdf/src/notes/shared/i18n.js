// Interface text in the browser's language, which follows the system's: chrome.i18n with
// _locales/zh_CN and _locales/en (the default for every other language). Prompts sent to the
// model are not interface text and stay as they are, so notes are written in Chinese either way.

/** Message `key`, with $1…$9 filled in from `subs`. */
export function tr(key, ...subs) {
  try {
    return chrome.i18n.getMessage(key, subs.map(String));
  } catch {
    return ''; // the extension was reloaded under this page
  }
}

/**
 * Translate a page: data-i18n (text), data-i18n-html (markup from our own messages only),
 * data-i18n-title / -placeholder / -aria-label (attributes); and set <html lang>.
 * Call before wiring up the page, as data-i18n-html replaces the element's children.
 */
export function localize(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = tr(el.dataset.i18nHtml);
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, tr(el.getAttribute(`data-i18n-${attr}`)));
  }
}
