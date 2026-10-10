<script setup lang="ts">
import { ref, computed } from 'vue';

const emit = defineEmits<{
  close: [];
  action: [name: string];
}>();

const query = ref('');
const actions = [
  { id: 'open', name: '打开文档', icon: 'i-lucide-book-open', keys: 'Ctrl+O' },
  { id: 'theme-light', name: '切到浅色主题', icon: 'i-lucide-sun', keys: '' },
  { id: 'theme-sepia', name: '切到护眼主题', icon: 'i-lucide-book-open', keys: '' },
  { id: 'theme-dark', name: '切到深色主题', icon: 'i-lucide-moon', keys: '' },
  { id: 'toggle-fullscreen', name: '切换全屏', icon: 'i-lucide-maximize-2', keys: 'f / F11' },
  { id: 'back-to-shelf', name: '返回书架', icon: 'i-lucide-corner-up-left', keys: 'Ctrl+B' },
  { id: 'show-help', name: '键位帮助', icon: 'i-lucide-help-circle', keys: '?' },
  { id: 'show-toc', name: '打开目录', icon: 'i-lucide-list', keys: 't' },
  { id: 'show-notes', name: '打开笔记', icon: 'i-lucide-sticky-note', keys: 'Ctrl+N' },
  { id: 'restart', name: '从头再读', icon: 'i-lucide-refresh-cw', keys: '' },
];

const filtered = computed(() => {
  const t = query.value.toLowerCase();
  if (!t) return actions;
  return actions.filter((a) => a.name.toLowerCase().includes(t) || a.id.includes(t));
});

function pick(a: typeof actions[number]) {
  emit('action', a.id);
  emit('close');
}
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal-card max-w-xl">
      <div class="flex items-center gap-2 mb-3">
        <span class="i-lucide-search text-pd-dim" />
        <input
          v-model="query"
          class="flex-1 bg-transparent outline-none text-base"
          placeholder="搜动作..."
          autofocus
        />
        <kbd>Esc</kbd>
      </div>
      <ul class="space-y-1 max-h-[50vh] overflow-y-auto">
        <li
          v-for="a in filtered"
          :key="a.id"
          class="toc-item"
          @click="pick(a)"
        >
          <span :class="a.icon" />
          <span class="flex-1">{{ a.name }}</span>
          <kbd v-if="a.keys" class="text-xs">{{ a.keys }}</kbd>
        </li>
        <li v-if="filtered.length === 0" class="text-pd-dim text-sm px-3 py-2">
          没有匹配项。
        </li>
      </ul>
    </div>
  </div>
</template>