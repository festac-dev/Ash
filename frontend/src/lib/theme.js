// Apply paired foreground/background colors in one style update. Hover and motion
// transitions resume after the new palette is established.
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.themeChanging = "true";
  void root.offsetWidth;
  root.dataset.theme = theme;
  void root.offsetWidth;
  delete root.dataset.themeChanging;
}
