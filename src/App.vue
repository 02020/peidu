<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import EntryScreen from './ui/EntryScreen.vue';
import ReaderView from './ui/ReaderView.vue';
import { readPrefs } from '@platform/store';
import { syncBigClass, toggleFullscreen } from '@platform/window';
import { readClipboardText } from '@platform/shell';
import { invoke } from '@tauri-apps/api/core';

const currentView = ref<'entry' | 'reader'>('entry');
const currentPath = ref('');
const prefs = ref<Awaited<ReturnType<typeof readPrefs>> | null>(null);

let unlistenDragDrop: (() => void) | undefined;
let unlistenStartup: (() => void) | undefined;
let unlistenDeepLink: (() => void) | undefined;

onMounted(async () => {
  // 加载 prefs
  prefs.value = await readPrefs();

  // 应用主题
  if (prefs.value?.theme) {
    document.documentElement.setAttribute('data-theme', prefs.value.theme);
  }

  // Q4: 应用字体
  if (prefs.value?.fontFamily) {
    document.documentElement.setAttribute('data-font', prefs.value.fontFamily);
  }

  // 同步 .big 全屏类
  await syncBigClass();

  // 监听窗口尺寸变化（兼容 resize 触发全屏）
  const win = getCurrentWindow();
  win.onResized(async () => {
    await syncBigClass();
  });

  // F1: Tauri 接管拖放（dragDropEnabled=true 时）
  // 拿到绝对路径数组，取第一个打开
  const webview = getCurrentWebview();
  unlistenDragDrop = await webview.onDragDropEvent((e) => {
    if (e.payload.type === 'drop') {
      const path = e.payload.paths[0];
      if (path) openReader(path);
    }
  });

  // F2: 全局全屏入口键（EntryScreen / ReaderView 通用）
  window.addEventListener('keydown', onGlobalKeydown);

  // D3-T3: 启动参数 — peidu open <path>
  unlistenStartup = await listen<string[]>('startup_args', (e) => {
    // args[0]=subcommand, args[1]=path
    const args = e.payload;
    if (args[0] === 'open' && args[1]) openReader(args[1]);
  });
  // D3-T3: 深链接 peidu://open?path=...
  unlistenDeepLink = await listen<string[]>('deep_link', (e) => {
    const urls = e.payload;
    for (const u of urls) {
      const m = u.match(/[?&]path=([^&]+)/);
      if (m) openReader(decodeURIComponent(m[1]));
    }
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  unlistenDragDrop?.();
  unlistenStartup?.();
  unlistenDeepLink?.();
});

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement) return;
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'f' || e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === 'v' && e.ctrlKey && e.shiftKey) {
    // Ctrl+Shift+V: 剪贴板陪读
    e.preventDefault();
    openClipboardAsDoc();
  }
}

async function openClipboardAsDoc() {
  try {
    const txt = await readClipboardText();
    if (txt && txt.trim().length > 0) {
      // 写到临时文件再打开
      const tmpPath = await invoke<string>('open_clipboard_doc', { text: txt });
      openReader(tmpPath);
    }
  } catch (e) {
    console.error('clipboard open:', e);
  }
}

function openReader(path: string) {
  currentPath.value = path;
  currentView.value = 'reader';
}

function backToEntry() {
  currentView.value = 'entry';
  currentPath.value = '';
}
</script>

<template>
  <EntryScreen v-if="currentView === 'entry'" @open="openReader" />
  <ReaderView v-else :path="currentPath" @back="backToEntry" />
</template>
