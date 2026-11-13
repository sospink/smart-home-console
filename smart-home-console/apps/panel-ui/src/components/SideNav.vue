<script setup lang="ts">
import { ChartNoAxesCombined, Grid2X2, House, LayoutDashboard, Leaf, Settings, ShieldCheck } from "lucide-vue-next";

withDefaults(defineProps<{ active: string; alertCount?: number; connected?: boolean }>(), { connected: true });
const emit = defineEmits<{ select: [id: string] }>();

const items = [
  { id: "home", label: "首页", icon: House },
  { id: "scenes", label: "场景", icon: LayoutDashboard },
  { id: "devices", label: "设备", icon: Grid2X2 },
  { id: "security", label: "安防", icon: ShieldCheck },
  { id: "environment", label: "环境", icon: Leaf },
  { id: "energy", label: "能耗", icon: ChartNoAxesCombined },
  { id: "settings", label: "设置", icon: Settings }
];
</script>

<template>
  <aside class="side-nav" aria-label="主屏导航">
    <div class="nav-caption"><span>空间控制</span><small>主屏</small></div>
    <button v-for="item in items" :key="item.id" :class="{ active: active === item.id }" @click="emit('select', item.id)">
      <component :is="item.icon" :size="21" :stroke-width="1.7" />
      <span>{{ item.label }}</span>
      <b v-if="item.id === 'security' && alertCount">{{ alertCount }}</b>
    </button>
    <div class="nav-status" :class="{ offline: !connected }">
      <i /><span>{{ connected ? "本地服务在线" : "服务重连中" }}</span>
    </div>
  </aside>
</template>

<style scoped>
.side-nav {
  width: 128px;
  min-width: 128px;
  display: flex;
  flex-direction: column;
  padding: 18px 12px 14px;
  background: var(--nav-surface);
  border-right: 0;
  box-shadow: 12px 0 32px rgba(40, 47, 58, 0.025);
}
.nav-caption {
  display: flex;
  justify-content: space-between;
  padding: 3px 10px 17px;
  color: var(--faint);
  font:
    11px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.18em;
  white-space: nowrap;
}
.nav-caption small {
  color: var(--cyan);
  font-size: inherit;
}
.side-nav button {
  position: relative;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 10px;
  color: var(--muted);
  background: transparent;
  border-radius: 14px;
  font-size: 11px;
  text-align: left;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.side-nav button > span,
.nav-status > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: keep-all;
}
.side-nav button:hover {
  color: var(--text);
  background: var(--control);
  transform: translateX(2px);
}
.side-nav button.active {
  color: var(--text);
  background: var(--selected);
  transform: none;
}
.side-nav button.active :deep(svg) {
  color: var(--cyan);
  filter: none;
}
.side-nav button:hover :deep(svg) {
  color: var(--text-soft);
}
.side-nav button.active:hover :deep(svg) {
  color: var(--cyan);
}
.side-nav b {
  margin-left: auto;
  min-width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--danger);
  border-radius: 9px;
  font-size: 9px;
}
.nav-status {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 5px 0;
  color: var(--muted);
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  letter-spacing: 0.08em;
  box-shadow: none;
}
.nav-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 4px var(--green-soft);
}
.nav-status.offline {
  color: var(--danger);
}
.nav-status.offline i {
  background: var(--danger);
  box-shadow: 0 0 0 4px var(--danger-soft);
}
@media (max-width: 1250px) {
  .side-nav {
    width: 110px;
    min-width: 110px;
  }
  .side-nav button {
    padding-inline: 10px;
    gap: 9px;
    font-size: 11px;
  }
}
@media (max-width: 900px) {
  .side-nav {
    width: 72px;
    min-width: 72px;
    align-items: center;
    padding-inline: 8px;
  }
  .nav-caption {
    width: 100%;
    justify-content: center;
    padding-inline: 0;
  }
  .nav-caption span,
  .side-nav button > span,
  .nav-status > span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .side-nav button {
    width: 52px;
    justify-content: center;
    gap: 0;
    padding: 0;
  }
  .side-nav b {
    position: absolute;
    top: 4px;
    right: 3px;
  }
  .nav-status {
    justify-content: center;
    padding-inline: 0;
  }
}
</style>
