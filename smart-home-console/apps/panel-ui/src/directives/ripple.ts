import type { Directive } from "vue";

const onPointerDown = (event: PointerEvent) => {
  if (document.documentElement.dataset.motion === "off") return;
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.25;
  const ripple = document.createElement("span");
  ripple.className = "touch-ripple";
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.querySelectorAll(":scope > .touch-ripple").forEach((item) => item.remove());
  target.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  // WebView 暂停、页面隐藏或运行时关闭动效时，animationend 可能不会触发。
  window.setTimeout(() => ripple.remove(), 700);
};

export const ripple: Directive<HTMLElement> = {
  mounted(element) {
    element.classList.add("ripple-host");
    element.addEventListener("pointerdown", onPointerDown);
  },
  unmounted(element) {
    element.removeEventListener("pointerdown", onPointerDown);
  }
};
