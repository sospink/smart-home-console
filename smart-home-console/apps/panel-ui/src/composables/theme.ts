import { computed, readonly, ref } from "vue";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "zhijing-theme";
const theme = ref<ThemeMode>("light");
let initialized = false;

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

function applyTheme(value: ThemeMode) {
  theme.value = value;
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", value === "dark" ? "#101113" : "#f5f6f7");
}

export function initializeTheme() {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 受限 WebView 可能禁用存储，仍允许本次会话正常切换。
  }
  applyTheme(isThemeMode(stored) ? stored : "light");

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && isThemeMode(event.newValue)) applyTheme(event.newValue);
  });
}

export function setTheme(value: ThemeMode) {
  if (typeof window === "undefined") return;
  applyTheme(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 主题切换不依赖持久化成功。
  }
}

export function useTheme() {
  initializeTheme();
  const isDark = computed(() => theme.value === "dark");
  return {
    theme: readonly(theme),
    isDark,
    setTheme,
    toggleTheme: () => setTheme(isDark.value ? "light" : "dark")
  };
}
