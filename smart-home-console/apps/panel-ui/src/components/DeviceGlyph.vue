<script setup lang="ts">
import type { DeviceKind } from "@smart-lab/contracts";
import { Blinds, Disc3, Droplets, LampCeiling, LayoutPanelTop, LockKeyhole, RadioTower, ShieldAlert, ToggleLeft } from "lucide-vue-next";

defineProps<{ kind: DeviceKind; sensorType?: string; size?: number }>();
</script>

<template>
  <RadioTower v-if="kind === 'gateway'" :size="size ?? 22" />
  <LampCeiling v-else-if="kind === 'light'" :size="size ?? 22" />
  <Blinds v-else-if="kind === 'cover'" :size="size ?? 22" />
  <LockKeyhole v-else-if="kind === 'lock'" :size="size ?? 22" />
  <Disc3 v-else-if="kind === 'media'" :size="size ?? 22" />
  <ToggleLeft v-else-if="kind === 'switch'" :size="size ?? 22" />
  <LayoutPanelTop v-else-if="kind === 'panel'" :size="size ?? 22" />
  <Droplets v-else-if="sensorType === 'waterLeak'" :size="size ?? 22" />
  <ShieldAlert v-else :size="size ?? 22" />
</template>
