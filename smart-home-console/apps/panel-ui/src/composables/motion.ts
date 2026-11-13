import { readonly, ref } from "vue";
import { isMotionMode, resolveMotionMode, type MotionMode } from "../lib/motion";

const STORAGE_KEY = "zhijing-motion";
const motionMode = ref<MotionMode>("full");
let initialized = false;
let systemQuery: MediaQueryList | undefined;

function storedPreference() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function applyMotionMode(value: MotionMode) {
  motionMode.value = value;
  document.documentElement.dataset.motion = value;
}

function syncSystemPreference() {
  const stored = storedPreference();
  if (!isMotionMode(stored)) applyMotionMode(resolveMotionMode(stored, systemQuery?.matches ?? false));
}

export function initializeMotionPreference() {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  systemQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  applyMotionMode(resolveMotionMode(storedPreference(), systemQuery.matches));
  systemQuery.addEventListener?.("change", syncSystemPreference);

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyMotionMode(resolveMotionMode(event.newValue, systemQuery?.matches ?? false));
  });
}

export function setMotionMode(value: MotionMode) {
  if (typeof window === "undefined") return;
  applyMotionMode(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 受限 WebView 禁用存储时，本次会话仍可使用选择结果。
  }
}

export function useMotionPreference() {
  initializeMotionPreference();
  return { motionMode: readonly(motionMode), setMotionMode };
}
