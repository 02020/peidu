<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{ close: [] }>();

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'q') {
    event.preventDefault();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal-card">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">键位帮助</h3>
        <button class="btn" @click="$emit('close')"><span class="i-lucide-x" /></button>
      </div>

      <table class="w-full text-sm">
        <tbody>
          <tr><td class="py-1"><kbd>Space</kbd> / <kbd>→</kbd> / <kbd>Enter</kbd></td><td class="py-1">下一段</td></tr>
          <tr><td class="py-1"><kbd>←</kbd></td><td class="py-1">上一段</td></tr>
          <tr><td class="py-1"><kbd>t</kbd></td><td class="py-1">目录</td></tr>
          <tr><td class="py-1"><kbd>?</kbd></td><td class="py-1">本帮助</td></tr>
          <tr><td class="py-1"><kbd>f</kbd> / <kbd>F11</kbd></td><td class="py-1">全屏切换</td></tr>
          <tr><td class="py-1"><kbd>Esc</kbd></td><td class="py-1">关模态 → 退全屏</td></tr>
          <tr><td class="py-1"><kbd>q</kbd> / 点击遮罩</td><td class="py-1">关模态</td></tr>
          <tr><td class="py-1"><kbd>Ctrl</kbd>+<kbd>O</kbd></td><td class="py-1">打开文件</td></tr>
          <tr><td class="py-1"><kbd>Ctrl</kbd>+<kbd>B</kbd></td><td class="py-1">返回书架</td></tr>
          <tr><td class="py-1"><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td class="py-1">命令面板（D4）</td></tr>
          <tr><td class="py-1"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd></td><td class="py-1">剪贴板陪读</td></tr>
          <tr><td class="py-1"><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>（全局）</td><td class="py-1">呼出 + 剪贴板陪读（D4）</td></tr>
          <tr><td class="py-1"><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td class="py-1">搜索（D2/D4）</td></tr>
        </tbody>
      </table>

      <p class="mt-4 text-xs text-pd-dim">
        按 <kbd>Esc</kbd> 或 <kbd>q</kbd> 关闭
      </p>
    </div>
  </div>
</template>
