/**
 * fitSeg v2 — 纯切割分页引擎（切割优先于缩字号）
 *
 * 规则（优先级从上到下）:
 * 1. 一段一屏: 每个 Segment 从新页开始, 不与其它段共页
 * 2. 切割优先于缩字号: 字号跟屏幕走 (--read-fs, CSS 决定), 放不下就切
 * 3. 长段切多页: 段落按句界切割 (单步碎片 ≤ maxPieceEm 等效字, 默认 480);
 *    表格/代码/列表/引用按渲染行预算切, 表格续片自动补表头(表头+分隔线)
 * 4. 短段不强接: 装不满就留白 (内容顶部对齐)
 * 5. 标题(heading)不孤悬: 页尾放不下 [标题+2行] 时整块翻页; 空页强放防死循环
 *
 * 坐标系: piece.from/to 是段内 md 偏移 (tokens 逐 raw 前缀和, 与 tokSpans 一致),
 *        渲染一律走 renderPiece(seg, piece) — v1 的 seg.text 切法已废弃
 *
 * 480 语义: 「段落按字数切割的单步碎片上限」而非整页上限 (等效字: 1 中文字 ≈ 1,
 *          英文字符 ≈ 0.5; 小屏因行预算自然更小)。一行常量 maxPieceEm 可调。
 */
import { marked } from 'marked';

export interface FitSegment {
  kind?: string;
  title?: string;
  text?: string;
  raw: string;
  tokens: any[];
}

export interface FitSegOptions {
  viewportHeight: number;
  viewportWidth?: number;
  fontSizePx: number;
  lineHeightRatio?: number;
  gapPx?: number;
  maxPieceEm?: number;
}

export type CutAlgorithm = 'single' | 'split-para' | 'split-code' | 'split-table' | 'split-list';
export type PieceFragment = 'md' | 'code' | 'table' | 'list' | 'blockquote' | 'html';

export interface PagePiece {
  segIdx: number;
  from: number;
  to: number;
  frag: PieceFragment;
}

export interface PageCut {
  segIndexes: number[];
  pieces: PagePiece[];
  algorithm: CutAlgorithm;
  estimatedHeight: number;
  fillRatio: number;
  fontSize: number;
  isContinuation?: boolean;
  continuationTitle?: string;
}

export interface FitResult {
  pages: PageCut[];
  pageCount: number;
}

const DEF_LINE_RATIO = 1.7;
const DEF_GAP_PX = 16;
const DEF_MAX_PIECE_EM = 480;
const CONT_TITLE_H = 44; // 续页顶部标题栏占高
const HEAD_TAIL_LINES = 2; // 标题后至少跟随行数（防孤悬）

/* ============ 等效字测量 ============ */

function charEm(cp: number, mono: boolean): number {
  if (cp >= 0x2e80) return 1;
  if (cp === 0x20 || cp === 0x09) return mono ? 0.62 : 0.32;
  if (cp < 0x80) return mono ? 0.62 : 0.5;
  return 1;
}

export function measureEm(text: string, mono = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch.codePointAt(0)!, mono);
  return em;
}

interface Metrics {
  fs: number;
  lineH: number;
  emPerLine: number;
  capH: number;
  gap: number;
  maxEm: number;
}

function mkMetrics(o: FitSegOptions): Metrics {
  const fs = o.fontSizePx > 0 ? o.fontSizePx : 22;
  const ratio = o.lineHeightRatio && o.lineHeightRatio > 0 ? o.lineHeightRatio : DEF_LINE_RATIO;
  const vw = o.viewportWidth && o.viewportWidth > 0 ? o.viewportWidth : fs * 30;
  const vh = o.viewportHeight > 0 ? o.viewportHeight : fs * 30;
  const lineH = fs * ratio;
  return {
    fs,
    lineH,
    emPerLine: Math.max(1, Math.floor(vw / fs)),
    capH: Math.max(lineH, Math.floor(vh / lineH) * lineH),
    gap: o.gapPx != null && o.gapPx >= 0 ? o.gapPx : DEF_GAP_PX,
    maxEm: o.maxPieceEm && o.maxPieceEm > 0 ? o.maxPieceEm : DEF_MAX_PIECE_EM,
  };
}

function linesOf(em: number, m: Metrics): number {
  return Math.max(1, Math.ceil(em / m.emPerLine - 1e-6));
}

/** 续页顶部有《标题 · N》栏, 可容纳行数按行量化后减掉 */
function capOf(m: Metrics, segPage: number): number {
  if (segPage <= 0) return m.capH;
  return Math.max(m.lineH, Math.floor((m.capH - CONT_TITLE_H) / m.lineH) * m.lineH);
}

/* ============ token 片段与 span ============ */

interface TokSpan {
  tok: any;
  start: number;
  end: number;
}

function tokFrag(tok: any): PieceFragment {
  switch (tok.type) {
    case 'code':
      return 'code';
    case 'table':
      return 'table';
    case 'list':
      return 'list';
    case 'blockquote':
      return 'blockquote';
    case 'html':
      return 'html';
    default:
      return 'md';
  }
}

function isHidden(tok: any): boolean {
  return tok.type === 'space' || tok.type === 'def';
}

function isAtomic(tok: any): boolean {
  return tok.type === 'heading' || tok.type === 'html' || tok.type === 'hr';
}

function isMono(f: PieceFragment): boolean {
  return f === 'code';
}

function tokSpans(seg: FitSegment): TokSpan[] {
  const out: TokSpan[] = [];
  let off = 0;
  for (const t of seg.tokens || []) {
    if (isHidden(t)) continue;
    const raw = typeof t.raw === 'string' ? t.raw : '';
    if (!raw) continue;
    out.push({ tok: t, start: off, end: off + raw.length });
    off += raw.length;
  }
  return out;
}

function mdOf(spans: TokSpan[]): string {
  return spans.map((s) => s.tok.raw as string).join('');
}

function locateSp(spans: TokSpan[], cur: number): TokSpan | null {
  for (const sp of spans) if (sp.end > cur) return sp;
  return null;
}

/* ============ 片高估算 (px) ============ */

function srcLines(s: string): number {
  const t = s.replace(/\n+$/, '');
  return t === '' ? 0 : t.split('\n').length;
}

/**
 * 表格/代码/列表/引用逐行渲染 (每源行至少占 1 渲染行), 段落按等效字折算行数
 */
function pieceHeight(slice: string, frag: PieceFragment, m: Metrics): number {
  const wl = linesOf(measureEm(slice, isMono(frag)), m);
  const lines = frag === 'md' || frag === 'html' ? wl : Math.max(srcLines(slice), wl);
  return lines * m.lineH;
}

/* ============ 切割器 ============ */

/** 句界: 中文句末标点 / 换行 / 英文句点(后跟空格或结尾) */
const SENT_RE = /[。！？；!?;…][）」』】]*|\n|\.(?=\s|$|\u0001)/g;

/**
 * 段落按句界切割; 单步碎片 ≤ min(limitEm, maxEm=480).
 * 窗口扫描: 句界累积超过 hardEm 即停; 至少累积到 0.4×hardEm 才允许落点;
 * 无句界兜底延迟按字符硬切 (超长无标点文本).
 */
function cutPara(md: string, start: number, end: number, limitEm: number, m: Metrics): number {
  const hardEm = Math.min(limitEm, m.maxEm);
  const scanLen = Math.min(end - start, Math.ceil(hardEm * 3.2) + 64);
  const win = md.slice(start, start + scanLen) + '\u0001';
  let best = -1;
  let acc = 0;
  let pos = 0;
  SENT_RE.lastIndex = 0;
  let mt: RegExpExecArray | null;
  while ((mt = SENT_RE.exec(win))) {
    const endPos = mt.index + mt[0].length;
    acc += measureEm(win.slice(pos, endPos));
    pos = endPos;
    if (acc > hardEm) break;
    const cut = start + pos;
    if (cut >= end) {
      best = end;
      break;
    }
    if (acc >= hardEm * 0.4) best = cut;
  }
  if (best > start) return Math.min(best, end);
  // 无句界兜底: 按字符硬切到 hardEm
  let off = 0;
  let em = 0;
  for (const ch of win) {
    const e = charEm(ch.codePointAt(0)!, false);
    if (em + e > hardEm + 1e-6) break;
    em += e;
    off += ch.length;
  }
  return off > 0 ? Math.min(start + off, end) : Math.min(start + 1, end);
}

/** 顶层列表项: 行首缩进 0 的项目符号 (- + *) 或有序号 (1. / 1)) */
const ITEM_RE = /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]|$)/;

function indentOf(s: string): number {
  return (s.match(/^[ \t]*/) || [''])[0].length;
}

/**
 * 表格/代码/列表/引用按渲染行预算切 (表格行会因列宽折行, 用 em 折算修正).
 * preferItem: 列表切点回退到「下一行是顶层项」的边界 (不切开子项).
 * minLines: 表格首批至少 [表头+分隔线] 2 行; 单行超长时整行放入允许溢出.
 */
function cutByLines(
  raw: string,
  start: number,
  end: number,
  maxLines: number,
  mono: boolean,
  preferItem: boolean,
  minLines: number,
  m: Metrics,
): number {
  const starts: number[] = [start];
  for (let i = start; i < end; i++) {
    if (raw[i] === '\n' && i + 1 < end) starts.push(i + 1);
  }
  const lineEnd = (k: number): number => (k + 1 < starts.length ? starts[k + 1] : end);
  let acc = 0;
  let capLines = 0;
  for (let k = 0; k < starts.length; k++) {
    const em = measureEm(raw.slice(starts[k], lineEnd(k)).replace(/\n+$/, ''), mono);
    const ll = Math.max(1, Math.ceil(em / m.emPerLine - 1e-6));
    if (k > 0 && acc + ll > maxLines) break;
    acc += ll;
    capLines = k + 1;
    if (lineEnd(k) >= end) break;
  }
  if (capLines < minLines) return lineEnd(Math.min(minLines, starts.length) - 1); // 宁可小幅溢出也要保住 [表头+分隔线]
  const last = lineEnd(capLines - 1);
  if (last >= end) return end;
  if (preferItem) {
    for (let k = capLines - 1; k >= minLines - 1; k--) {
      const le = lineEnd(k);
      const next = raw.slice(le);
      if (ITEM_RE.test(next) && indentOf(next) === 0) return le;
    }
  }
  return last;
}

function algoOf(f: PieceFragment): CutAlgorithm {
  if (f === 'code') return 'split-code';
  if (f === 'table') return 'split-table';
  if (f === 'list') return 'split-list';
  return 'split-para';
}

/** 在 token 内切一刀, 返回段内 md 偏移 */
function cutFrag(sp: TokSpan, md: string, cursor: number, room: number, m: Metrics): number {
  const raw = sp.tok.raw as string;
  const frag = tokFrag(sp.tok);
  const lines = Math.max(1, Math.floor(room / m.lineH + 1e-6));
  const local = cursor - sp.start;
  if (frag === 'code') return sp.start + cutByLines(raw, local, raw.length, lines, true, false, 1, m);
  if (frag === 'table') {
    const first = local === 0;
    const bud = first && lines < 2 ? 2 : lines;
    return sp.start + cutByLines(raw, local, raw.length, bud, false, false, first ? 2 : 1, m);
  }
  if (frag === 'list') return sp.start + cutByLines(raw, local, raw.length, lines, false, true, 1, m);
  if (frag === 'blockquote') return sp.start + cutByLines(raw, local, raw.length, lines, false, false, 1, m);
  return cutPara(md, cursor, sp.end, lines * m.emPerLine, m);
}

/* ============ 主板: 一段一屏 → 页内打包/切割 ============ */

export function fitSeg(segments: FitSegment[], opts: FitSegOptions): FitResult {
  const m = mkMetrics(opts);
  const pages: PageCut[] = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const spans = tokSpans(seg);
    if (spans.length === 0) continue;
    const contentLen = spans[spans.length - 1].end;
    const md = mdOf(spans);
    const title = String(seg.title || seg.text || '续').slice(0, 24) || '续';

    // fast path: 整段 (token 间无 gap — preflight margin=0) 一屏装得下
    let wholeH = 0;
    for (const sp of spans) wholeH += pieceHeight(sp.tok.raw as string, tokFrag(sp.tok), m);
    if (wholeH <= m.capH + 1e-6) {
      pages.push({
        segIndexes: [si],
        pieces: [{ segIdx: si, from: 0, to: contentLen, frag: 'md' }],
        algorithm: 'single',
        estimatedHeight: wholeH,
        fillRatio: Math.min(1, wholeH / m.capH),
        fontSize: m.fs,
      });
      continue;
    }

    let cursor = 0;
    let segPage = 0;
    while (cursor < contentLen) {
      const cap = capOf(m, segPage);
      const pieces: PagePiece[] = [];
      let usedH = 0;
      while (cursor < contentLen) {
        const sp = locateSp(spans, cursor);
        if (!sp) {
          cursor = contentLen;
          break;
        }
        const raw = sp.tok.raw as string;
        const frag = tokFrag(sp.tok);
        const gap = pieces.length > 0 ? m.gap : 0;
        const room = cap - usedH - gap;
        let to = sp.end;
        if (isAtomic(sp.tok)) {
          const h = pieceHeight(raw, frag, m);
          // 标题不孤悬: 页尾放不下 [标题+2行] 就翻页; 空页强放防死循环
          if (pieces.length > 0 && room < h + m.gap + HEAD_TAIL_LINES * m.lineH) break;
        } else {
          const tokH = pieceHeight(raw, frag, m);
          if (tokH > room + 1e-6) {
            if (room < m.lineH) break;
            const cut = cutFrag(sp, md, cursor, room, m);
            to = Math.max(cursor + 1, Math.min(cut, sp.end));
          }
        }
        const slice = md.slice(cursor, to);
        pieces.push({ segIdx: si, from: cursor, to, frag });
        usedH += gap + pieceHeight(slice, frag, m);
        cursor = to;
      }
      if (pieces.length === 0) break;
      const single = pieces.length === 1 && pieces[0].from === 0 && pieces[0].to >= contentLen;
      pages.push({
        segIndexes: [si],
        pieces,
        algorithm: single ? 'single' : algoOf(pieces[0].frag),
        estimatedHeight: Math.min(usedH, cap),
        fillRatio: Math.min(1, usedH / cap),
        fontSize: m.fs,
        ...(segPage > 0 ? { isContinuation: true, continuationTitle: `${title} · ${segPage + 1}` } : {}),
      });
      segPage++;
    }
  }

  return { pages, pageCount: pages.length };
}

/* ============ 渲染 ============ */

/** 按 piece 偏移渲染; 整段直返 seg.raw (fast path 零重排) */
export function renderPiece(seg: FitSegment, p: PagePiece): string {
  const spans = tokSpans(seg);
  if (spans.length === 0) return '';
  const contentLen = spans[spans.length - 1].end;
  if (p.from <= 0 && p.to >= contentLen) return seg.raw;
  const parts: string[] = [];
  for (const sp of spans) {
    const raw = sp.tok.raw as string;
    const a = Math.max(0, p.from - sp.start);
    const b = Math.min(raw.length, p.to - sp.start);
    if (b <= a) continue;
    if (a <= 0 && b >= raw.length) {
      parts.push(raw);
      continue;
    }
    const frag = tokFrag(sp.tok);
    if (frag === 'html') {
      parts.push(raw.slice(a, b));
      continue;
    }
    parts.push(sliceToken(sp.tok, raw, a, b));
  }
  const md = parts.join('\n\n');
  if (p.frag === 'html') return md;
  return marked.parse(md, { async: false }) as string;
}

/** 单片 token 的续片修复: 表格补表头 / 代码块补围栏 */
function sliceToken(tok: any, raw: string, a: number, b: number): string {
  if (tok.type === 'table' && a > 0) {
    const body = raw.slice(a, b).replace(/^\n+/, '');
    let i = 0;
    let seen = 0;
    while (i < raw.length && seen < 2) {
      if (raw[i] === '\n') seen++;
      i++;
    }
    return raw.slice(0, i) + body;
  }
  if (tok.type === 'code') return repairCode(tok, raw, a, b);
  return raw.slice(a, b);
}

function repairCode(tok: any, raw: string, a: number, b: number): string {
  // marked v12 code token 无 fenced 标记, 只能从 raw 前缀区分围栏/缩进
  const fm = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!fm) {
    const body = raw.slice(a, b).split('\n').map((l) => l.replace(/^(?: {4}|\t)/, '')).join('\n');
    return '```\n' + body.replace(/\n+$/, '') + '\n```';
  }
  const marker = fm[1]!;
  const lang = typeof tok.lang === 'string' ? tok.lang.trim().split(/\s+/)[0] || '' : '';
  let out = (a > 0 ? marker + lang + '\n' : '') + raw.slice(a, b);
  if (b < raw.length) out = out.replace(/\n+$/, '') + '\n' + marker;
  return out;
}
