try {
  document.documentElement.dataset.theme = localStorage.getItem("ash-theme") === "light" ? "light" : "dark";
} catch {
  /* Use the default theme when storage is unavailable. */
}
