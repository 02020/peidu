// platform/window.ts
// 全屏 .big 类同步 + Esc 栈 + 单实例参数转发 + 竖屏自动全屏 + 状态记忆/还原。

import { getCurrentWindow } from '@tauri-apps/api/window';

/** 同步 .big 类与窗口全屏状态 */
export async function syncBigClass(): Promise<void> {
  const win = getCurrentWindow();
  const fs = await win.isFullscreen();
  document.documentElement.classList.toggle('big', fs);
}

/** 切换全屏 */
export async function toggleFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  const fs = await win.isFullscreen();
  await (fs ? win.setFullscreen(false) : win.setFullscreen(true));
  await syncBigClass();
}

/** 退出全屏（Esc 栈用） */
export async function exitFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isFullscreen()) {
    await win.setFullscreen(false);
    await syncBigClass();
  }
}

/** T2: 竖屏自动全屏 */
export async function autoFullscreenForPortrait(): Promise<void> {
  if (typeof window === 'undefined') return;
  const isPortrait = window.matchMedia?.('(orientation: portrait)').matches;
  if (!isPortrait) return;
  const win = getCurrentWindow();
  if (!(await win.isFullscreen())) {
    await win.setFullscreen(true);
    await syncBigClass();
  }
}

/** T2: 记录进入阅读屏前是否处于全屏状态 — 退出阅读时还原 */
let preReaderFullscreen: boolean | null = null;

export function rememberBigState(): void {
  // 进入阅读前先记下当前全屏状态
  // 不能用 await — 同帧调用. 用同步读 DOM
  preReaderFullscreen = document.documentElement.classList.contains('big');
}

export async function restoreBigState(): Promise<void> {
  if (preReaderFullscreen === null) return;
  const wasFull = preReaderFullscreen;
  preReaderFullscreen = null;
  if (!wasFull) {
    // 进入前非全屏 → 退出全屏
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
      await syncBigClass();
    }
  }
  // 如果进入前就是全屏, 保持全屏不动
}

/** 单实例：监听 second-instance 事件——Tauri 启动时已注册，此处仅占位 */
export function onSecondInstance(_handler: (args: string[]) => void): void {
  // Tauri 插件 internal API；通过 main.rs 转发到事件总线
  // 实际订阅见 src/platform/shell.ts
}
