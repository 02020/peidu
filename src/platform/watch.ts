// platform/watch.ts
// notify 监听封装 + 防抖。
// D3 实现；D0/D1 仅占位。

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface WatchEvent {
  path: string;
  kind: 'modify' | 'create' | 'remove';
  ts: number;
}

export async function startWatch(path: string): Promise<void> {
  await invoke('start_watch', { path });
}

export async function stopWatch(): Promise<void> {
  await invoke('stop_watch');
}

/** 监听 watch 事件（带 300ms 防抖，窗内合并） */
export function onWatchEvent(
  handler: (events: WatchEvent[]) => void,
): Promise<UnlistenFn> {
  let buf: WatchEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = 300;

  const flush = () => {
    timer = null;
    if (buf.length) {
      const events = buf;
      buf = [];
      handler(events);
    }
  };

  return listen<WatchEvent>('watch_event', (e) => {
    buf.push(e.payload);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
}
