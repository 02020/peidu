// core/fitSeg.ts
// 按内容切割引擎 — 字号固定, 不缩
//
// 规则 (按你最终拍板):
//   1. 字号固定 = base (CSS --read-fs, 全屏最小 36, 窗口最小 22)
//   2. 目标字数: target = ⌊avail/lineH⌋ × cpl — 一屏装满的字数
//   3. 标题切分: H1 永远独占, H2/H3 看上下文 (短共, 长独, 同级共)
//   4. code/table 永远独占
//   5. 单段: 装得下 → single-display, 装不下 → split-by-line/block (按句号切, 不缩)
//   6. 多段: 累加字数 ≤ target × 0.92 就共页, 超就开新页
//   7. 短段 (≤ 50 字): 强制接下几段, 拼接到接近 target
//   8. 不缩字号! 段装不下就切多页
//   9. 短段独立 ≤ 50 字 + 不强制拼 (被前一段挤出去) → 允许上下空白

export interface FitSegOptions {
  /** 视口高度 (像素) */
  viewportHeight: number;
  /** 视口宽度 (像素) — 备用 */
  viewportWidth?: number;
  /** 字号像素 (固定) */
  fontSizePx: number;
  /** 是否全屏模式 (仅 debug) */
  isBigMode?: boolean;
  /** 段间距像素 (默认 fontSizePx * 0.5) */
  gapPx?: number;
}

export type CutAlgorithm =
  | 'dense-pack'
  | 'merged-tiny'
  | 'title-break'
  | 'single-display'
  | 'split-by-line'
  | 'split-by-block'
  | 'code-block'
  | 'table-block';

export interface PageSlice {
  segIdx: number;
  start: number;
  end: number;
}

export interface PageCut {
  segIndexes: number[];
  slices: PageSlice[];
  algorithm: CutAlgorithm;
  estimatedHeight: number;
  fillRatio: number;
  /** 字号 (固定 = base) */
  fontSize: number;
  isContinuation?: boolean;
  continuationTitle?: string;
}

export interface FitResult {
  pages: PageCut[];
  pageCount: number;
}

// ---------- 阈值 ----------

const FILL_DENSE = 0.92;     // dense-pack 装到 92% 算满
const FILL_TINY = 1.05;      // merged-tiny 装到 1.05
const GAP_RATIO = 0.5;
const SHORT_SEG_LEN = 50;    // 短段 ≤50 字, 强制拼接
const VERY_LONG_SEG_LEN = 2000;

// ---------- 工具 ----------

function charsPerLineAt(fontSize: number): number {
  return Math.max(15, 30 + (fontSize - 18) * 1.2);
}

function segHeight(text: string, fontSize: number, lineH: number, gap: number, cpl: number): number {
  const lines = Math.max(1, Math.ceil(text.length / cpl));
  return lines * lineH + gap;
}

function isTitleKind(k: any): boolean {
  return k === 'h1' || k === 'h2' || k === 'h3';
}

function titleMustBreak(kind: any, nextKind: any, nextLen: number): boolean {
  if (kind === 'h1') return true;
  if (kind !== 'h2' && kind !== 'h3') return false;
  if (nextKind === kind) return false;
  if (nextKind !== undefined && nextKind !== null) {
    if (isTitleKind(nextKind) === false && nextLen <= SHORT_SEG_LEN * 4) return false;  // 短内容(<200字)共
  } else {
    return false;  // 无后续段
  }
  return true;
}

function splitBySentence(text: string, target: number): { left: string; right: string } {
  if (text.length <= target) return { left: text, right: '' };
  const puncts = ['。', '！', '?', '?', '!', '.\n', '!\n', '?\n', '\n\n'];
  let best = -1;
  for (const p of puncts) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(p, from);
      if (idx < 0) break;
      if (idx > best && idx >= Math.floor(target * 0.5) && idx <= Math.floor(target * 1.3)) {
        best = idx + p.length;
      }
      from = idx + p.length;
    }
  }
  if (best <= 0) best = target;
  return { left: text.slice(0, best), right: text.slice(best) };
}

function splitByBlock(text: string, target: number): { left: string; right: string } {
  if (text.length <= target) return { left: text, right: '' };
  const breaks = ['\n\n', '```\n', '---\n'];
  let best = -1;
  for (const p of breaks) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(p, from);
      if (idx < 0) break;
      if (idx > best && idx >= Math.floor(target * 0.5) && idx <= Math.floor(target * 1.3)) {
        best = idx + p.length;
      }
      from = idx + p.length;
    }
  }
  if (best <= 0) best = target;
  return { left: text.slice(0, best), right: text.slice(best) };
}

function targetChars(avail: number, fontSize: number, lineH: number, cpl: number): number {
  const linesPerPage = Math.floor(avail / lineH);
  return Math.max(80, linesPerPage * cpl);
}

function segHeightTotal<T extends { text: string }>(
  segs: T[],
  indices: number[],
  fs: number,
  lineH: number,
  gap: number,
  cpl: number,
): number {
  let total = 0;
  for (let i = 0; i < indices.length; i++) {
    total += segHeight(segs[indices[i]!]!.text, fs, lineH, gap, cpl);
    if (i > 0) total += gap;
  }
  return total;
}

// ---------- 入口 ----------

export function fitSeg<T extends { text: string; kind?: string }>(
  segments: T[],
  opts: FitSegOptions,
): FitResult {
  const base = opts.fontSizePx;
  const isBig = !!opts.isBigMode;
  const lineH = base * 1.7;
  const gap = opts.gapPx ?? base * GAP_RATIO;
  const cpl = charsPerLineAt(base);
  const avail = opts.viewportHeight;
  const target = targetChars(avail, base, lineH, cpl);

  if (segments.length === 0 || avail <= 0) {
    return { pages: [], pageCount: 0 };
  }

  const pages: PageCut[] = [];
  let buf: number[] = [];
  const flushBuf = () => {
    if (buf.length === 0) return;
    const cuts = dispatchPack(segments, buf, avail, base, lineH, gap, cpl, target);
    pages.push(...cuts);
    buf = [];
  };
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (isTitleKind(seg.kind)) {
      const next = i + 1 < segments.length ? segments[i + 1]! : null;
      const nextKind = next?.kind ?? null;
      const nextLen = next?.text.length ?? 0;
      if (titleMustBreak(seg.kind, nextKind, nextLen)) {
        flushBuf();
        pages.push(makePageCut([i], segments, 0, seg.text.length, 'title-break', avail, base, lineH, gap, cpl, isBig));
      } else {
        buf.push(i);
      }
    } else if (seg.kind === 'code' || seg.kind === 'table') {
      flushBuf();
      const algo: 'code-block' | 'table-block' = seg.kind === 'code' ? 'code-block' : 'table-block';
      pages.push(makePageCut([i], segments, 0, seg.text.length, algo, avail, base, lineH, gap, cpl, isBig));
    } else {
      buf.push(i);
    }
  }
  flushBuf();

  return { pages, pageCount: pages.length };
}

// ---------- 缩字号 (web 版 §6.4) ----------

const FILL_LOW = 0.85;
const FILL_HIGH = 1.02;
const TARGET_FILL_LOW = 0.90;
const TARGET_FILL_HIGH = 0.97;
const ABSOLUTE_MIN_FS_BIG = 36;
const ABSOLUTE_MIN_FS_WINDOW = 22;
const MAX_FS_RATIO = 2.5;
const MIN_FS_RATIO = 0.7;
const MAX_PASS = 3;
const CONVERGE_PX = 0.5;

/**
 * sqrt 缩字号填满 — 每页独立, 按内容切之后做
 *
 * @param textLength 段总字符数 (多段累加)
 * @param avail 可用视口高
 * @param base 基准字号
 * @param isBig 全屏模式
 */
function shrinkToFill(
  textLength: number,
  avail: number,
  base: number,
  isBig: boolean,
): { fs: number; height: number; fill: number } {
  const absoluteMin = isBig ? ABSOLUTE_MIN_FS_BIG : ABSOLUTE_MIN_FS_WINDOW;
  const lo = Math.max(absoluteMin, base * MIN_FS_RATIO);
  const hi = base * MAX_FS_RATIO;
  let cur = base;
  let curLineH = cur * 1.7;
  let curCpl = charsPerLineAt(cur);
  let lines = Math.max(1, Math.ceil(textLength / curCpl));
  let h = lines * curLineH + (textLength > 0 ? cur * GAP_RATIO : 0);
  for (let pass = 0; pass < MAX_PASS; pass++) {
    if (h <= 0) break;
    if (h >= avail * FILL_LOW && h <= avail * FILL_HIGH) break;
    const want = cur * Math.sqrt(
      (h < avail * FILL_LOW ? avail * TARGET_FILL_LOW : avail * TARGET_FILL_HIGH) / h,
    );
    const clamped = Math.max(lo, Math.min(hi, want));
    if (Math.abs(clamped - cur) < CONVERGE_PX) { cur = clamped; break; }
    cur = clamped;
    // 重新算 h — 字符数不变, 但 cpl / lineH 跟字号走
    curCpl = charsPerLineAt(cur);
    curLineH = cur * 1.7;
    lines = Math.max(1, Math.ceil(textLength / curCpl));
    h = lines * curLineH + (textLength > 0 ? cur * GAP_RATIO : 0);
  }
  return { fs: cur, height: h, fill: h / avail };
}

// ---------- 单页函数 ----------

function makePageCut<T extends { text: string; kind?: string }>(
  segIds: number[],
  segs: T[],
  start: number,
  end: number,
  algo: CutAlgorithm,
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
  isBig: boolean,
  isContinuation?: boolean,
  continuationTitle?: string,
): PageCut {
  // 字符数累加 (多段)
  let textLength = 0;
  for (let i = 0; i < segIds.length; i++) {
    const idx = segIds[i]!;
    if (i === 0) {
      textLength += end - start;
    } else {
      textLength += segs[idx]!.text.length;
    }
  }
  // 缩字号填满 avail — 按内容切之后
  const { fs, height, fill } = shrinkToFill(textLength, avail, base, isBig);
  return {
    segIndexes: segIds,
    slices: segIds.map((i, idx) => ({
      segIdx: i,
      start: idx === 0 ? start : 0,
      end: idx === 0 ? end : segs[i]!.text.length,
    })),
    algorithm: algo,
    estimatedHeight: height,
    fillRatio: fill,
    fontSize: fs,
    isContinuation,
    continuationTitle,
  };
}

function dispatchPack<T extends { text: string; kind?: string }>(
  segs: T[],
  indices: number[],
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
  target: number,
): PageCut[] {
  if (indices.length === 0) return [];

  // 单段
  if (indices.length === 1) {
    return splitOrShowOne(segs, indices, avail, base, lineH, gap, cpl, target);
  }

  // 多段
  const chars = indices.reduce((s, i) => s + segs[i]!.text.length, 0);
  const avgChars = chars / indices.length;
  if (avgChars <= SHORT_SEG_LEN) {
    return mergedTiny(segs, indices, avail, base, lineH, gap, cpl);
  }
  return densePack(segs, indices, avail, base, lineH, gap, cpl, target);
}

function splitOrShowOne<T extends { text: string; kind?: string }>(
  segs: T[],
  indices: number[],
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
  target: number,
): PageCut[] {
  const segIdx = indices[0]!;
  const seg = segs[segIdx]!;
  const text = seg.text;
  const h = segHeight(text, base, lineH, gap, cpl);
  // 装得下 (1 屏内) — 注意: 不缩字号, 也不强制 0.62-1.02 范围
  // 单段超 1 屏但 ≤ 1.05×target: 仍单页 (允许段略超, 内容连贯)
  if (h <= avail * 1.02) {
    return [makePageCut([segIdx], segs, 0, text.length, 'single-display', avail, base, lineH, gap, cpl, false)];
  }
  // 装不下 — 切
  const veryLong = text.length > VERY_LONG_SEG_LEN;
  return splitLong(segs, segIdx, avail, base, lineH, gap, cpl, target, veryLong ? 'split-by-block' : 'split-by-line');
}

function splitLong<T extends { text: string; kind?: string }>(
  segs: T[],
  segIdx: number,
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
  target: number,
  algo: 'split-by-line' | 'split-by-block',
): PageCut[] {
  const seg = segs[segIdx]!;
  const splitFn = algo === 'split-by-block' ? splitByBlock : splitBySentence;
  const out: PageCut[] = [];
  let rest = seg.text;
  let consumed = 0;
  const baseTitle = seg.text.slice(0, 20).replace(/\s+/g, ' ').trim() || '续';
  // 每次切 target 长度
  while (rest.length > target * 1.02) {
    const { left, right } = splitFn(rest, target);
    if (!left || left.length >= rest.length) break;
    const end = consumed + left.length;
    out.push(makePageCut([segIdx], segs, consumed, end, algo, avail, base, lineH, gap, cpl, false, consumed > 0, consumed > 0 ? `${baseTitle} · ${out.length + 1}` : undefined));
    consumed = end;
    rest = right;
  }
  if (rest.length > 0) {
    out.push(makePageCut([segIdx], segs, consumed, consumed + rest.length, algo, avail, base, lineH, gap, cpl, false, consumed > 0, consumed > 0 ? `${baseTitle} · ${out.length + 1}` : undefined));
  }
  return out;
}

/**
 * dense-pack — 多段共页 (上限 3 段)
 *  - 第一段总是进 cur
 *  - 第 2 段: 超 target × 1.5 → flush; 否则接
 *  - 第 3 段: 超 target × 1.2 → flush; 否则接
 *  - 第 4 段: 强制 flush
 *  - 首段本身 ≤ 50 字 (短段): 单独一页, 不强接, 接受不满
 */
function densePack<T extends { text: string; kind?: string }>(
  segs: T[],
  indices: number[],
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
  target: number,
): PageCut[] {
  const out: PageCut[] = [];
  let cur: number[] = [];
  let curChars = 0;
  const flush = () => {
    if (cur.length === 0) return;
    const h = segHeightTotal(segs, cur, base, lineH, gap, cpl);
    out.push({
      segIndexes: cur,
      slices: cur.map((i) => ({ segIdx: i, start: 0, end: segs[i]!.text.length })),
      algorithm: 'dense-pack',
      estimatedHeight: h,
      fillRatio: h / avail,
      fontSize: base,
    });
    cur = []; curChars = 0;
  };
  for (const i of indices) {
    const seg = segs[i]!;
    const segChars = seg.text.length;
    if (cur.length === 0) {
      // 首段进 cur
      cur.push(i);
      curChars += segChars;
      // 首段本身 ≤ 50 字: 单独一页, 不强接
      if (segChars <= SHORT_SEG_LEN) {
        flush();
      }
      continue;
    }
    // 已有 1+ 段
    if (cur.length >= 3) {
      // 第 4 段起: 强制 flush
      flush();
    } else if (cur.length === 2) {
      // 第 3 段: 超 target × 1.2 → flush, 否则接
      if (curChars + segChars + gap > target * 1.2) flush();
    } else {
      // 第 2 段: 超 target × 1.5 → flush, 否则接
      if (curChars + segChars + gap > target * 1.5) flush();
    }
    cur.push(i);
    curChars += segChars;
  }
  flush();
  return out;
}

/**
 * merged-tiny — 碎小段多段共页 (装到 1.05x, 但不缩字号, 仅靠短段自然填)
 */
function mergedTiny<T extends { text: string; kind?: string }>(
  segs: T[],
  indices: number[],
  avail: number,
  base: number,
  lineH: number,
  gap: number,
  cpl: number,
): PageCut[] {
  const out: PageCut[] = [];
  let cur: number[] = [];
  let curH = 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push({
      segIndexes: cur,
      slices: cur.map((i) => ({ segIdx: i, start: 0, end: segs[i]!.text.length })),
      algorithm: 'merged-tiny',
      estimatedHeight: curH,
      fillRatio: curH / avail,
      fontSize: base,
    });
    cur = []; curH = 0;
  };
  for (const i of indices) {
    const seg = segs[i]!;
    const h = segHeight(seg.text, base, lineH, gap, cpl);
    if (cur.length > 0 && curH + h + gap > avail * FILL_TINY) flush();
    cur.push(i);
    curH += h;
  }
  flush();
  return out;
}

// ---------- 兼容 shim ----------

export function measureSeg(s: { text: string }, opts: {
  fontSizePx: number;
  lineHeightPx?: number;
  gapPx?: number;
  charsPerLine?: number;
}): number {
  const fs = opts.fontSizePx;
  const lineH = opts.lineHeightPx ?? fs * 1.7;
  const gap = opts.gapPx ?? fs * GAP_RATIO;
  const cpl = opts.charsPerLine ?? charsPerLineAt(fs);
  return segHeight(s.text, fs, lineH, gap, cpl);
}

export function shrinkGrow<T extends { text: string }>(
  _segments: T[],
  _pageSegIndexes: number[],
  baseFontSize: number,
): number {
  return baseFontSize;
}