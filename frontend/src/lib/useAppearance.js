import { useEffect, useState } from "react";
import { applyTheme } from "./theme.js";

export function useAppearance() {
  const [theme, setTheme] = useState("dark");
  const [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setTheme(localStorage.getItem("ash-theme") === "light" ? "light" : "dark");
    } catch {}
    setReady(true);
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(preference.matches);
    changed();
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!ready) return;
    applyTheme(theme);
    try {
      localStorage.setItem("ash-theme", theme);
    } catch {}
  }, [theme, ready]);
  return { theme, reduced, toggleTheme: () => setTheme((value) => (value === "dark" ? "light" : "dark")) };
}
