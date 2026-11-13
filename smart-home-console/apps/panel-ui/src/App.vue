<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView } from "vue-router";
import { useRoute } from "vue-router";
import { useEdgeStore } from "./stores/edge";
import SyncPulse from "./components/SyncPulse.vue";
import StartupGate from "./components/StartupGate.vue";

const edge = useEdgeStore();
const route = useRoute();
const panelSurface = computed(() => (route.meta.role === "primary" || route.meta.role === "secondary" ? route.meta.role : undefined));
const startupBlocked = computed(() => Boolean(panelSurface.value && !edge.snapshot));

function resumeWhenVisible() {
  if (!document.hidden) void edge.verifyConnectionLiveness();
}

onMounted(() => {
  void edge.connect();
  window.addEventListener("online", edge.resumeConnection);
  window.addEventListener("offline", edge.suspendForOffline);
  document.addEventListener("visibilitychange", resumeWhenVisible);
});
onUnmounted(() => {
  window.removeEventListener("online", edge.resumeConnection);
  window.removeEventListener("offline", edge.suspendForOffline);
  document.removeEventListener("visibilitychange", resumeWhenVisible);
  edge.disconnect();
});
</script>

<template>
  <StartupGate v-if="startupBlocked && panelSurface" :surface="panelSurface" />
  <template v-else>
    <RouterView />
    <SyncPulse />
  </template>
</template>
