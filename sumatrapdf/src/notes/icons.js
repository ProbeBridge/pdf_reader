const paths = {
  speak: '<path d="M3 7.6h2.9L10 4.2v11.6l-4.1-3.4H3zM13.2 7.3a3.8 3.8 0 0 1 0 5.4M15.6 4.9a7.2 7.2 0 0 1 0 10.2"/>',
  ask: '<path d="M4.2 4h11.6c.9 0 1.7.8 1.7 1.7v7.1c0 .9-.8 1.7-1.7 1.7H9.4L5.6 17.6v-3.1H4.2c-.9 0-1.7-.8-1.7-1.7V5.7C2.5 4.8 3.3 4 4.2 4z"/>',
  regen: '<path d="M16.2 7.2A6.6 6.6 0 1 0 16.6 12M16.6 3.4v4.1h-4.1"/>',
  copy: '<rect x="7" y="7" width="10" height="10.5" rx="1.6"/><path d="M13 4.6V4.2c0-.7-.6-1.2-1.2-1.2H4.2C3.5 3 3 3.5 3 4.2v7.6c0 .7.5 1.2 1.2 1.2H5"/>',
  del: '<path d="M3.5 5.5h13M8 5.5V3.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.6M5.1 5.5l.8 10.7c.1.8.7 1.3 1.5 1.3h5.2c.8 0 1.4-.5 1.5-1.3l.8-10.7M8.4 8.8v5.4M11.6 8.8v5.4"/>',
};
export const svg = (name) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
export function setIcon(button, name, label) {
  button.innerHTML = svg(name);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.add("icon");
  return button;
}
