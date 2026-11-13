<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Check, LayoutDashboard, MonitorCog, PanelsTopLeft, Settings2, Smartphone, X } from "lucide-vue-next";
import {
  nativeBridge,
  nativeTerminalRole,
  rememberNativeSurface,
  requestNativeTerminalReconfiguration,
  type PanelSurface
} from "../lib/terminal-runtime";

const route = useRoute();
const router = useRouter();
const root = ref<HTMLElement>();
const open = ref(false);
const available = Boolean(nativeBridge());
const role = nativeTerminalRole() ?? "primary";
const currentSurface = computed<PanelSurface>(() =>
  route.path === "/secondary" ? "secondary" : route.path === "/admin" ? "admin" : "primary"
);
const defaultSurface: PanelSurface = role;
const roleLabel = role === "primary" ? "主屏终端" : "副屏终端";
const surfaceLabel: Record<PanelSurface, string> = {
  primary: "主屏工作台",
  secondary: "副屏工作台",
  admin: "工程管理"
};
const surfaces = [
  { id: "primary" as const, label: "主屏工作台", detail: "设备、场景与状态", icon: LayoutDashboard },
  { id: "secondary" as const, label: "副屏工作台", detail: "高频控制与状态", icon: Smartphone },
  { id: "admin" as const, label: "工程管理", detail: "需 PIN 验证", icon: Settings2 }
];

onMounted(() => {
  document.addEventListener("pointerdown", closeOutside);
  document.addEventListener("keydown", closeOnEscape);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", closeOutside);
  document.removeEventListener("keydown", closeOnEscape);
});

function closeOutside(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function closeOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

async function navigate(surface: PanelSurface) {
  rememberNativeSurface(surface);
  open.value = false;
  if (currentSurface.value !== surface) await router.push(`/${surface}`);
}

function reconfigureTerminal() {
  open.value = false;
  requestNativeTerminalReconfiguration();
}
</script>

<template>
  <div v-if="available" ref="root" class="terminal-surface-menu">
    <button
      class="surface-trigger"
      aria-label="切换工作界面"
      title="切换工作界面"
      :aria-expanded="open"
      aria-controls="terminal-surface-popover"
      @click="open = !open"
    >
      <PanelsTopLeft :size="18" />
    </button>
    <Transition name="surface-pop">
      <section v-if="open" id="terminal-surface-popover" class="surface-popover" aria-label="终端工作界面">
        <header>
          <div class="surface-heading">
            <span class="surface-mark"><MonitorCog :size="18" /></span>
            <div><strong>终端工作界面</strong><small>切换界面不会改变本机身份</small></div>
          </div>
          <button aria-label="关闭终端菜单" @click="open = false"><X :size="17" /></button>
        </header>

        <div class="identity-strip">
          <span
            ><small>本机身份</small><strong>{{ roleLabel }}</strong></span
          >
          <i />
          <span
            ><small>当前界面</small><strong>{{ surfaceLabel[currentSurface] }}</strong></span
          >
        </div>

        <nav>
          <button
            v-for="surface in surfaces"
            :key="surface.id"
            :class="{ current: currentSurface === surface.id }"
            :aria-current="currentSurface === surface.id ? 'page' : undefined"
            @click="navigate(surface.id)"
          >
            <span class="surface-icon"><component :is="surface.icon" :size="19" /></span>
            <span
              ><strong>{{ surface.label }}</strong
              ><small>{{ surface.detail }}</small></span
            >
            <Check v-if="currentSurface === surface.id" :size="17" />
          </button>
        </nav>

        <footer>
          <button v-if="currentSurface !== defaultSurface" @click="navigate(defaultSurface)">返回本机默认界面</button>
          <button class="reconfigure" @click="reconfigureTerminal">重新配置本机身份</button>
        </footer>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.terminal-surface-menu {
  position: relative;
}
.surface-trigger {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--control);
  border-radius: 50%;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 180ms var(--ease-out);
}
.surface-trigger:hover,
.surface-trigger[aria-expanded="true"] {
  color: var(--cyan);
  background: var(--selected);
}
.surface-trigger:active {
  transform: scale(0.94);
}
.surface-popover {
  position: absolute;
  z-index: 150;
  top: calc(100% + 10px);
  right: -92px;
  width: min(370px, calc(100vw - 24px));
  padding: 13px;
  color: var(--text);
  background: color-mix(in srgb, var(--card) 98%, transparent);
  border-radius: 22px;
  box-shadow: var(--shadow-float);
  backdrop-filter: blur(20px) saturate(1.16);
}
.surface-popover > header {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 3px 11px;
}
.surface-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.surface-mark,
.surface-icon {
  display: grid;
  place-items: center;
  color: var(--cyan);
  background: var(--selected);
}
.surface-mark {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 13px;
}
.surface-heading > div,
.identity-strip span,
nav button > span:nth-child(2) {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.surface-heading strong {
  font-size: 13px;
}
.surface-heading small,
.identity-strip small,
nav small {
  color: var(--muted);
  font-size: 11px;
}
.surface-popover > header > button {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: transparent;
  border-radius: 50%;
}
.identity-strip {
  display: grid;
  grid-template-columns: 1fr 1px 1fr;
  align-items: center;
  gap: 13px;
  padding: 12px 14px;
  background: var(--card-soft);
  border-radius: 16px;
}
.identity-strip i {
  width: 1px;
  height: 27px;
  background: var(--line-strong);
}
.identity-strip strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
nav {
  display: grid;
  gap: 5px;
  margin-top: 9px;
}
nav button {
  min-height: 62px;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 11px;
  padding: 7px 11px 7px 8px;
  color: var(--text-soft);
  background: transparent;
  border-radius: 16px;
  text-align: left;
  transition:
    color 150ms ease,
    background-color 150ms ease,
    transform 180ms var(--ease-out);
}
nav button:hover {
  color: var(--text);
  background: var(--control);
}
nav button:active {
  transform: scale(0.985);
}
nav button.current {
  color: var(--cyan);
  background: var(--selected);
}
.surface-icon {
  width: 40px;
  height: 40px;
  color: var(--text-soft);
  background: var(--control);
  border-radius: 13px;
}
nav button.current .surface-icon {
  color: var(--cyan);
  background: color-mix(in srgb, var(--cyan) 12%, var(--card));
}
nav strong {
  color: var(--text);
  font-size: 12px;
}
nav button > svg {
  justify-self: end;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 52px;
  margin-top: 8px;
  padding: 7px 5px 0;
}
footer button {
  min-height: 44px;
  padding: 0 9px;
  color: var(--cyan);
  background: transparent;
  border-radius: 12px;
  font-size: 11px;
}
footer .reconfigure {
  margin-left: auto;
  color: var(--muted);
}
.surface-pop-enter-active,
.surface-pop-leave-active {
  transition:
    opacity 170ms ease,
    transform 230ms var(--ease-out);
  transform-origin: top right;
}
.surface-pop-enter-from,
.surface-pop-leave-to {
  opacity: 0;
  transform: translateY(-7px) scale(0.97);
}
@media (max-width: 900px) {
  .surface-popover {
    position: fixed;
    top: 62px;
    right: 12px;
  }
}
@media (max-height: 520px) {
  .surface-popover {
    max-height: calc(100vh - 72px);
    overflow: auto;
  }
  nav button {
    min-height: 56px;
  }
}
</style>
