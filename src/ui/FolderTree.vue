<script setup lang="ts">
// P1: 树组件懒渲染——折叠子节点不渲染, 不递归组件自身
import { ref } from 'vue';
import type { FolderNode } from '@platform/fs';

defineProps<{
  node: FolderNode;
  depth?: number;
}>();

const emit = defineEmits<{
  open: [path: string];
}>();

// 节点本地展开状态 — 由 path 索引
const expandedMap = ref<Record<string, boolean>>({});
function isExpanded(path: string, defaultOpen: boolean): boolean {
  if (path in expandedMap.value) return expandedMap.value[path]!;
  return defaultOpen;
}
function toggle(path: string) {
  expandedMap.value[path] = !expandedMap.value[path];
}
function indentCls(depth: number): string {
  return `ml-${Math.min(depth * 3, 12)}`;
}
</script>

<template>
  <!-- P1: 扁平渲染 + 懒加载 — 每行一个节点, 子节点按需展开 -->
  <div class="tree-node">
    <div
      class="toc-item"
      :class="indentCls(node.kind === 'file' ? (depth ?? 0) : (depth ?? 0))"
      @click="node.kind === 'dir' ? toggle(node.path) : emit('open', node.path)"
    >
      <span
        v-if="node.kind === 'dir'"
        :class="isExpanded(node.path, (depth ?? 0) < 2)
          ? 'i-lucide-chevron-down text-pd-dim'
          : 'i-lucide-chevron-right text-pd-dim'"
      />
      <span v-else class="i-lucide-book-open text-pd-acc" />
      <span class="flex-1 truncate" :class="node.kind === 'dir' ? 'text-pd-dim' : ''">
        {{ node.name }}
      </span>
      <span
        v-if="node.kind === 'dir' && node.children.length"
        class="text-xs text-pd-dim"
      >
        {{ node.children.length }}
      </span>
    </div>
    <!-- P1: 折叠时不渲染子节点 — 大树性能关键 -->
    <ul
      v-if="node.kind === 'dir' && isExpanded(node.path, (depth ?? 0) < 2) && node.children.length"
      class="space-y-0.5 mt-0.5"
    >
      <li v-for="c in node.children" :key="c.path">
        <FolderTree :node="c" :depth="(depth ?? 0) + 1" @open="emit('open', $event)" />
      </li>
    </ul>
  </div>
</template>