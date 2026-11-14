const root = document.documentElement;
const channel = root.dataset.themeChannel;
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const zh = navigator.language.toLowerCase().startsWith("zh");
let followsSystem = true;

function applyTheme(theme) {
  if (typeof theme?.dark !== "boolean") return;
  root.dataset.theme = theme.dark ? "dark" : "light";
  for (const [key, property] of Object.entries({
    background: "--surface",
    text: "--text",
    muted: "--muted",
    border: "--border",
  })) {
    const color = theme[key];
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) root.style.setProperty(property, color);
    else root.style.removeProperty(property);
  }
  for (const property of ["--history-background", "--search-background"]) {
    if (/^#[0-9a-f]{6}$/i.test(theme.background || "")) root.style.setProperty(property, theme.background);
    else root.style.removeProperty(property);
  }
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    const label = theme.dark
      ? zh
        ? "切换到浅色主题"
        : "Switch to light theme"
      : zh
        ? "切换到深色主题"
        : "Switch to dark theme";
    button.textContent = theme.dark ? "☀" : "☾";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(theme.dark));
  }
}
async function callTheme(action) {
  const theme = await globalThis.__sumatra__?.call(channel, JSON.stringify({ action }));
  if (typeof theme?.dark === "boolean") {
    followsSystem = false;
    applyTheme(theme);
  }
}
applyTheme({ dark: systemTheme.matches });
systemTheme.addEventListener("change", () => {
  if (followsSystem) applyTheme({ dark: systemTheme.matches });
});
window.addEventListener("themechange", (event) => {
  if (typeof event.detail?.dark !== "boolean") return;
  followsSystem = false;
  applyTheme(event.detail);
});
for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await callTheme("toggleTheme");
    } catch (error) {
      button.title = String(error?.message || error);
    } finally {
      button.disabled = false;
    }
  });
}
await callTheme("theme").catch(() => {});
