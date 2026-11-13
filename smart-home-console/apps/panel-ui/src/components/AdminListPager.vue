<script setup lang="ts">
import { NPagination, NSpin } from "naive-ui";

const props = defineProps<{
  resource: string;
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "update:page": [value: number];
  "update:pageSize": [value: number];
}>();
</script>

<template>
  <footer class="admin-list-pager" :data-resource="props.resource">
    <span>共 {{ total }} 条</span>
    <NSpin v-if="loading" size="small" />
    <NPagination
      :page="page"
      :page-size="pageSize"
      :item-count="total"
      :page-sizes="[4, 6, 8, 10, 20]"
      show-size-picker
      :page-slot="7"
      @update:page="emit('update:page', $event)"
      @update:page-size="emit('update:pageSize', $event)"
    />
  </footer>
</template>

<style scoped>
.admin-list-pager {
  min-height: 64px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  padding: 12px 8px 2px;
  color: var(--muted);
  font-size: 11px;
}
.admin-list-pager :deep(.n-pagination) {
  max-width: 100%;
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 8px;
}
.admin-list-pager :deep(.n-pagination-item) {
  min-width: 44px;
  height: 44px;
  border-radius: 12px;
}
.admin-list-pager :deep(.n-base-selection) {
  --n-height: 44px !important;
  min-height: 44px;
  border-radius: 12px;
}
.admin-list-pager :deep(.n-base-selection-label) {
  min-height: 44px;
  background: var(--card) !important;
  border-radius: 12px;
}
@container admin-content (max-width: 700px) {
  .admin-list-pager {
    justify-content: flex-start;
    gap: 9px;
    padding-inline: 0;
  }
  .admin-list-pager > span {
    flex: 1 0 100%;
  }
  .admin-list-pager :deep(.n-pagination) {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
