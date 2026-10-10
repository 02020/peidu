// platform/fs.ts
// 文件系统 + 文档读取 + 拖放路径 + 相对路径解析 + 图片 src 重写。
// 所有 Tauri invoke 调用都在此封装——core 层与 ui 层不直接调 Tauri。

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface ReadDocumentResult {
  text: string;
  encoding: string;
  size: number;
}

/** 通过 Tauri 命令读取文档——自动编码检测（Rust 端） */
export async function readDocument(path: string): Promise<ReadDocumentResult> {
  return await invoke<ReadDocumentResult>('read_document', { path });
}

/** 打开系统文件选择对话框 */
export async function pickFile(): Promise<string | null> {
  return await invoke<string | null>('pick_file', {
    options: {
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: 'Word（预留）', extensions: ['doc', 'docx'] },
      ],
    },
  });
}

/** 把绝对路径转为 webview 可加载的 src（用于图片等） */
export function fileSrc(absPath: string): string {
  return convertFileSrc(absPath);
}

/** 解析相对路径（相对 baseDir） */
export function resolveRelative(baseDir: string, rel: string): string {
  // 用 URL 解析语义——前端标准做法
  try {
    return new URL(rel, `file://${baseDir.replace(/\\/g, '/')}`).pathname.replace(/^\//, '');
  } catch {
    return rel;
  }
}

/** 从文件路径提取所在目录 */
export function dirOf(filePath: string): string {
  const sep = filePath.lastIndexOf('\\') >= 0 ? '\\' : '/';
  const idx = filePath.lastIndexOf(sep);
  return idx >= 0 ? filePath.slice(0, idx) : '';
}

/** Q2: 选文件夹对话框 — Tauri 原生 (open({directory:true})) */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ directory: true, multiple: false });
  if (typeof result === 'string') return result;
  return null;
}

/** T2: 递归列出目录树 */
export interface FolderNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children: FolderNode[];
}

/** T2: 递归列出目录树 — P1 默认 depth 4 + 后端限节点数 */
export async function loadFolderTree(path: string, maxDepth = 4): Promise<FolderNode> {
  return await invoke<FolderNode>('list_folder_tree', { path, maxDepth });
}
