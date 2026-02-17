import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "cory:themeMode";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "dark" || value === "light";
}

function initialThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isThemeMode(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useThemeMode(): {
  themeMode: ThemeMode;
  toggleThemeMode: () => void;
} {
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    localStorage.setItem(STORAGE_KEY, themeMode);
  }, [themeMode]);

  const toggleThemeMode = useCallback(() => {
    setThemeMode((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { themeMode, toggleThemeMode };
}
