// platform/shell.ts
// 外链 opener / CLI 参数 / 深链接 / 剪贴板（全局快捷键场景）。

import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';

/** 启动时拿到 CLI 参数（单实例转发或首次启动） */
export async function getStartupArgs(): Promise<string[]> {
  return await invoke<string[]>('get_startup_args');
}

/** 监听深链接（peidu://） */
export function onDeepLink(handler: (url: string) => void) {
  return listen<string>('deep_link', (e) => handler(e.payload));
}

/** 监听 second-instance（单实例转发） */
export function onSecondInstance(handler: (args: string[]) => void) {
  return listen<string[]>('second_instance', (e) => handler(e.payload));
}

/** 打开外链（http / https）—— 用系统默认浏览器 */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/** 读剪贴板文本 */
export async function readClipboardText(): Promise<string> {
  return await invoke<string>('read_clipboard_text');
}
