// core/anchor.ts
// 锚点恢复 / maxAnchor 已读重建 / 孤儿划线判定。
//
// 设计：
// - 段序号 = 主键。段文本 hash = 副键（防视觉漂移）
// - 重读文档后：尽量找回原段号；找不到则按文本 hash 模糊匹配到最近段
// - 找不到的划线 → 孤儿（灰显，但保留原始段号用于历史追溯）
//
// API 严格匹配 tests/segmenter.test.ts 的 anchor describe 块。

export interface Anchor {
  /** 段序号 */
  idx: number;
  /** 文本 hash（fnv1a 32-bit unsigned） */
  hash: number;
}

/** FNV-1a 32-bit hash——简单稳定 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 创建锚点：段号 + 段文本 */
export function makeAnchor(idx: number, text: string): Anchor {
  return { idx, hash: fnv1a(text) };
}

/**
 * 在新段数组中恢复旧锚点位置。
 * - 段序号匹配 + hash 一致：直接返回
 * - 段序号失效但 hash 匹配：返回新段号
 * - 都不匹配：返回 -1（孤儿）
 */
export function recoverAnchor<T extends { text: string }>(
  oldAnchor: Anchor,
  newSegments: T[],
): number {
  if (oldAnchor.idx >= 0 && oldAnchor.idx < newSegments.length) {
    const seg = newSegments[oldAnchor.idx];
    if (fnv1a(seg.text) === oldAnchor.hash) {
      return oldAnchor.idx;
    }
  }
  // 模糊匹配：找内容相同的段
  for (let i = 0; i < newSegments.length; i++) {
    if (fnv1a(newSegments[i].text) === oldAnchor.hash) return i;
  }
  return -1;
}

/**
 * 判定划线/笔记是否变为孤儿。
 */
export function isOrphan<T extends { text: string }>(
  anchor: Anchor,
  segments: T[],
): boolean {
  return recoverAnchor(anchor, segments) === -1;
}

/**
 * 在文档树中找"编辑点之前的最大已读段号"——即 maxAnchor。
 * 用于书架"已读 N 段"展示。
 */
export function maxReadAnchor<T extends { text: string }>(
  segments: T[],
  anchors: Anchor[],
): number {
  let max = -1;
  for (const a of anchors) {
    const idx = recoverAnchor(a, segments);
    if (idx > max) max = idx;
  }
  return max;
}

/**
 * 计算当前页 maxAnchor——单页内最大段号, 用于书架进度。
 */
export function computePageMaxAnchor(pageSegIndexes: number[]): number {
  if (!pageSegIndexes || pageSegIndexes.length === 0) return 0;
  return Math.max(...pageSegIndexes);
}

/** 兼容旧 API：段文本前缀（取前 16 字符，trim） */
export function textPrefix(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 16);
}
