import { useEffect, useState } from "react";

export function useAppearance() {
  const [theme, setTheme] = useState("dark");
  const [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setTheme(localStorage.getItem("ash-theme") === "light" ? "light" : "dark");
    } catch {
      /* Storage is optional. */
    }
    setReady(true);
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(preference.matches);
    changed();
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ash-theme", theme);
    } catch {
      /* Storage is optional. */
    }
  }, [theme, ready]);
  return { theme, reduced, toggleTheme: () => setTheme((value) => (value === "dark" ? "light" : "dark")) };
}
