// core/segmenter.ts
// P2 重写版：把 markdown 文本按"段"切分——每段是一屏阅读的基本单位。
//
// 算法来源：web 版 reader.html:2609-2703 的 lexToSegments（marked token 流版）。
// 设计文档 §6.3 标注此为本模块的迁移目标。
//
// 设计要点：
// - 纯函数：marked token 流是输入，DOM 渲染放 ui/ 层
// - 视口状态（bigMode、innerWidth/Height）通过参数传入 fitSeg，不进 segmenter
// - 段预算：bigMode ? clamp(min(W,H)/950, 1, 1.8) : 1；TARGET/MAX/MIN = 350/550/120 · k
// - 块边界拆段（超长节按 block 累积）；表格/代码/列表引导句粘合
// - 续段标题：`原标题 · 2` 处理跨页长章节
// - 孤标题并入下一段最前
// - 碎段合并：size<MIN 的段并入前一段
//
// 算法不依赖 DOM、不依赖框架——可在 node 单测。

import { marked, type Tokens } from 'marked';
import { highlightCode } from './highlight';

/**
 * D3 相对图片: 把 HTML 中的 <img src="..."> 重写为 asset:// 协议路径,
 * 让 WebView 能加载源文件旁边的图片。
 *
 * 注: 实际重写在 ReaderView 层做 — 这里暴露一个 helper 让 ReaderView
 * 在 v-html 前调一次。
 */
export function rewriteImages(html: string, baseDir: string, fileSrc: (abs: string) => string): string {
  // 简单正则——marked 已生成的 <img src="..."> 不会再包含未转义字符
  return html.replace(/<img\s+([^>]*?)src="([^"]+)"([^>]*)>/gi, (m, pre, src, post) => {
    // 跳过绝对 URL / data: / asset:
    if (/^(https?:|data:|asset:|http:\/\/asset\.localhost)/i.test(src)) return m;
    if (!baseDir) return m;
    // 解析相对路径
    let abs: string;
    try {
      abs = new URL(src, `file://${baseDir.replace(/\\/g, '/')}`).pathname.replace(/^\//, '');
    } catch {
      return m;
    }
    const newSrc = fileSrc(abs);
    return `<img ${pre}src="${newSrc}"${post}>`;
  });
}

export type SegmentKind = 'h1' | 'h2' | 'h3' | 'p' | 'code' | 'list' | 'quote' | 'hr' | 'table';

export interface Segment {
  /** 唯一 id（在文档内稳定） */
  id: string;
  /** 段类型 */
  kind: SegmentKind;
  /** 渲染后的纯文本（用于估算长度、目录显示） */
  text: string;
  /** 原始 markdown 文本（保留用于导出；外部 markdown 已加 links） */
  raw: string;
  /** 所属标题链（h1 链 + 当前 h2/h3）—— 用于目录 */
  breadcrumb: string[];
  /** 段序号（从 0 开始） */
  index: number;
  /** 段标题（用于目录与顶栏）；续段标 "原标题 · 2" */
  title: string;
  /** 是否为某标题的续段（>1 表示"原标题 · 2"形式的第 N 段） */
  cont: number;
  /** 该段包含的 marked token 数组——渲染时给 marked.parser 用 */
  tokens: any[];
  /** 当前段对应的原始 markdown 长度（用于书架进度展示） */
  size: number;
}

export interface SegmenterOptions {
  /** 是否为大屏模式（影响字数预算 k 系数） */
  bigMode?: boolean;
  /** 视口短边像素（横屏 vmin / 竖屏 vw）——用于 k 系数 */
  viewportShortPx?: number;
}

const DEFAULT_OPTS: Required<SegmenterOptions> = {
  bigMode: false,
  viewportShortPx: 950,
};

// ---- 主入口 ----

/**
 * 把 markdown 文本切分为段数组。
 * 算法严格对照 web 版 reader.html:2609-2703。
 */
export function lexToSegments(md: string, opts: SegmenterOptions = {}): Segment[] {
  const o = { ...DEFAULT_OPTS, ...opts };

  // 1) marked.lexer() 拿 token 流 + 引用式链接
  const toks = marked.lexer(md, { gfm: true }) as any[];
  const links: Record<string, { href: string; title?: string }> =
    (toks as any).links ?? {};

  // 2) 以 h1/h2 为边界开新段；其他 block 归入当前段
  interface Group {
    head: any | null;
    toks: any[];
    html: string;
    title: string;
    level: number;
    ci: number;
    base: string;
  }
  const groups: Group[] = [];
  let cur: Group | null = null;
  function newGroup(head: any | null) {
    cur = { head, toks: head ? [head] : [], html: '', title: '', level: head ? head.depth : 0, ci: 0, base: '' };
    groups.push(cur);
  }
  for (const t of toks) {
    if (t.type === 'space') continue;
    if (t.type === 'heading' && t.depth <= 2) { newGroup(t); continue; }
    if (!cur) newGroup(null);
    cur!.toks.push(t);
  }
  // 过滤空段
  const rawGroups = groups.filter((g) => g.toks.length);
  // 计算"裸字数"——按 raw.trim().length, 中文一字=1 字符

  // 4) 孤标题合并：段内只有一个标题 token、且下一段也有标题 → 上一个标题 unshift 到下一段最前
  const merged: Group[] = [];
  for (let j = 0; j < rawGroups.length; j++) {
    const gr = rawGroups[j];
    if (
      gr.head &&
      gr.toks.length === 1 &&
      j < rawGroups.length - 1 &&
      rawGroups[j + 1].head
    ) {
      rawGroups[j + 1].toks.unshift(gr.head);
      continue;
    }
    merged.push(gr);
  }

  // 5) 没有 h1/h2 的长文：按任意标题分组
  let groupsFinal = merged;
  if (groupsFinal.length < 2) {
    const flat: any[] = [];
    groupsFinal.forEach((gr) => gr.toks.forEach((t: any) => flat.push(t)));
    const g2: Group[] = [];
    let gcur: Group | null = null;
    flat.forEach((t: any) => {
      if (t.type === 'heading') {
        gcur = { head: t, toks: [t], html: '', title: '', level: t.depth, ci: 0, base: '' };
        g2.push(gcur);
        return;
      }
      if (!gcur) { gcur = { head: null, toks: [], html: '', title: '', level: 0, ci: 0, base: '' }; g2.push(gcur); }
      gcur.toks.push(t);
    });
    groupsFinal = g2.length >= 2 ? g2 : flat.length ? [{ head: null, toks: flat, html: '', title: '', level: 0, ci: 0, base: '' }] : [];
  }

  // 6) 字数预算（web 版 §5.2）
  const k = o.bigMode
      ? Math.max(1, Math.min(1.8, o.viewportShortPx / 950))
      : 1;
  const TARGET = Math.round(350 * k);
  const MAX = Math.round(550 * k);
  const MIN = Math.round(120 * k);

  // token size helper
  function tsize(t: any): number { return (t.raw || '').trim().length; }
  function gsize(gr: Group): number { return gr.toks.reduce((a, t) => a + tsize(t), 0); }

  // 7) 超长节按块边界拆——表格/代码/列表粘合引导句
  const out: Group[] = [];
  groupsFinal.forEach((gr) => {
    const size = gsize(gr);
    if (size <= MAX || gr.toks.length < 3) {
      out.push({ ...gr, html: '', ci: 0, base: gr.head?.text ?? '' });
      return;
    }
    const head = gr.head;
    const body = gr.toks.slice(head ? 1 : 0);
    const chunks: Group[] = [];
    let curHead: any | null = head;
    let ct: any[] = curHead ? [curHead] : [];
    let cs = curHead ? tsize(curHead) : 0;
    for (let b = 0; b < body.length; b++) {
      const tk = body[b];
      const ts = tsize(tk);
      const prev = ct[ct.length - 1];
      const glue = (tk.type === 'table' || tk.type === 'code' || tk.type === 'list') && prev && prev.type === 'paragraph';
      if (cs >= TARGET && !glue && ct.length > (curHead ? 1 : 0)) {
        chunks.push({
          head: curHead, toks: ct, html: '', title: '', level: curHead ? curHead.depth : 0,
          ci: chunks.length, base: gr.head?.text ?? '',
        });
        curHead = null;
        ct = [];
        cs = 0;
      }
      ct.push(tk);
      cs += ts;
    }
    if (ct.length) {
      chunks.push({
        head: curHead, toks: ct, html: '', title: '', level: curHead ? curHead.depth : 0,
        ci: chunks.length, base: gr.head?.text ?? '',
      });
    }
    // 尾 chunk 不足 MIN 并回上一段
    if (chunks.length > 1 && gsize(chunks[chunks.length - 1]) < MIN) {
      const last = chunks.pop()!;
      last.toks.forEach((t) => chunks[chunks.length - 1].toks.push(t));
    }
    out.push(...chunks);
  });

  // 8) 碎段并入前一段（size<MIN）
  const bal: Group[] = [];
  out.forEach((gr) => {
    if (bal.length && gsize(gr) < MIN) {
      bal[bal.length - 1].toks = bal[bal.length - 1].toks.concat(gr.toks);
    } else {
      bal.push(gr);
    }
  });
  // 首段过短 → 前向合并
  if (bal.length > 1 && gsize(bal[0]) < MIN) {
    bal[0].toks = bal[0].toks.concat(bal[1].toks);
    bal.splice(1, 1);
  }

  // 9) 段内渲染 + 标题
  const segs: Segment[] = [];
  bal.forEach((gr, idx) => {
    // 每段独立渲染——复制 links 让引用式链接可解析
    const arr = gr.toks.slice();
    (arr as any).links = links;
    const html = marked.parser(arr as any) as string;

    // D2: 代码块由 highlightCode 处理——marked 默认只产出 <pre><code>, 我们替换
    //     这里的实现是: 已经是 pre/code 不动它; marked 自己渲染的 code 默认无高亮
    //     真正的"表格 code 高亮"在 ReaderView 后处理里走 — 这里保持简单

    // 段标题优先级：h1/h2 文本 → 原标题 · N → 段内首个段落/标题前 20 字 → "（续）"
    let title = gr.head && gr.head.text ? gr.head.text : '';
    if (!title && gr.ci) title = `${gr.base || '续'} · ${gr.ci + 1}`;
    if (!title) {
      const first = (gr.toks as any[]).find(
        (t) => t.type === 'paragraph' || t.type === 'heading',
      );
      title = ((first && first.text ? first.text : '') as string)
        .replace(/[#*`>\[\]()]/g, '')
        .slice(0, 20) || '（续）';
    }

    // 段类型归类（用于 ReaderView 的模板/样式）
    const primary = gr.head ?? gr.toks.find((t) => t.type !== 'space') ?? null;
    const kind = classify(primary, gr.toks);

    // breadcrumb：h1 链 + 当前 h2/h3
    const breadcrumb = computeBreadcrumb(bal, idx);

    segs.push({
      id: `s${idx}`,
      kind,
      text: title,
      raw: html, // P2 后 raw 直接存渲染好的 HTML（ui 层用 v-html）
      breadcrumb,
      index: idx,
      title,
      cont: gr.ci + 1,
      tokens: gr.toks,
      size: gsize(gr),
    });
  });

  return segs;
}

// ---- 辅助 ----

function classify(head: any | null, toks: any[]): SegmentKind {
  if (head) {
    if (head.depth === 1) return 'h1';
    if (head.depth === 2) return 'h2';
    if (head.depth === 3) return 'h3';
    return 'p';
  }
  const first = toks.find((t) => t.type !== 'space');
  if (!first) return 'p';
  switch (first.type) {
    case 'code': return 'code';
    case 'list': return 'list';
    case 'blockquote': return 'quote';
    case 'hr': return 'hr';
    case 'table': return 'table';
    case 'heading':
      if (first.depth === 1) return 'h1';
      if (first.depth === 2) return 'h2';
      if (first.depth === 3) return 'h3';
      return 'p';
    default: return 'p';
  }
}

function computeBreadcrumb(groups: any[], idx: number): string[] {
  const chain: string[] = [];
  for (let i = 0; i <= idx; i++) {
    const head = groups[i].head;
    if (!head) continue;
    if (head.depth === 1) {
      chain.length = 0;
      chain.push(head.text);
    } else if (head.depth === 2) {
      // 保留 h1 + 当前 h2
      while (chain.length > 1) chain.pop();
      chain.push(head.text);
    } else if (head.depth === 3) {
      while (chain.length > 2) chain.pop();
      chain.push(head.text);
    }
  }
  return chain;
}