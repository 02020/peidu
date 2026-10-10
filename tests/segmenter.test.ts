import { describe, it, expect } from 'vitest';
import { lexToSegments } from '@core/segmenter';
import { fitSeg, renderPiece, measureEm } from '@core/fitSeg';
import { fnv1a, makeAnchor, recoverAnchor } from '@core/anchor';
import { esc } from '@core/highlight';
import { parseFrontmatter } from '@core/frontmatter';

describe('segmenter', () => {
  it('空输入产出空数组', () => {
    expect(lexToSegments('')).toEqual([]);
  });

  it('h1 后内容归入 h1 段', () => {
    // P2 后按 web 版 §5.1: h1/h2 为分组边界, h1 后内容归入 h1 段
    const md = '# 标题\n\n内容段落。';
    const segs = lexToSegments(md);
    expect(segs.length).toBe(1);
    expect(segs[0].kind).toBe('h1');
    expect(segs[0].title).toBe('标题');
  });

  it('h1 + h2 切两段', () => {
    // 短段会被并回前段（MIN=120）。要看到 2 段必须每段超 MIN。
    const longA = 'A 内容。'.repeat(40); // 280 字符 > 120
    const longB = 'B 内容。'.repeat(40);
    const md = `# 标题一\n\n${longA}\n\n## 标题二\n\n${longB}`;
    const segs = lexToSegments(md);
    expect(segs.length).toBe(2);
    expect(segs[0].kind).toBe('h1');
    expect(segs[0].title).toBe('标题一');
    expect(segs[1].kind).toBe('h2');
    expect(segs[1].title).toBe('标题二');
  });

  it('代码块归入所在段', () => {
    // P2 后代码块是所在段的子 token, 不单独成段
    const md = '# h\n\n```js\nconst x = 1;\n```';
    const segs = lexToSegments(md);
    expect(segs.length).toBe(1);
    expect(segs[0].kind).toBe('h1');
    // 段内 token 流包含 code
    expect(segs[0].tokens.some((t: any) => t.type === 'code')).toBe(true);
  });

  it('列表成一段 (无 h1/h2 时)', () => {
    // 无 h1/h2 时按"任意标题"分组; 纯列表文档兜底成一段
    const md = '- 苹果\n- 香蕉\n- 橘子';
    const segs = lexToSegments(md);
    expect(segs.length).toBeGreaterThanOrEqual(1);
  });

  it('超长段落被拆分', () => {
    // P2 后视口参与切分。MIN=120 / TARGET=350 / MAX=550 (bigMode=false)
    // 一个超长 h1 段含多个 paragraph, 每个 > MIN(120), 拆出 2+ 段
    const md = '# 长文\n\n' + '这是一段长文。'.repeat(100) + '\n\n' + '又是一段长文。'.repeat(60) + '\n\n' + '再来一段。'.repeat(40);
    const segs = lexToSegments(md);
    expect(segs.length).toBeGreaterThan(2);
  });

  it('续段标题', () => {
    // P2 后续段标题走 marked token 流, cont 从 ci 计算
    const md = '# 主标题\n\n第一段。\n\n第二段。\n\n第三段。';
    const segs = lexToSegments(md);
    // 主标题 1 段; 第一段/第二段/第三段各自一个 p (因为没有 h2 边界, 但 p 间空行会被 marked 当独立 paragraph)
    expect(segs[0].kind).toBe('h1');
    expect(segs[0].title).toBe('主标题');
  });

  it('空输入产出空数组', () => {
    expect(lexToSegments('')).toEqual([]);
  });
});

describe('fitSeg (纯切割 v2)', () => {
  // fs=20, vw=400 → emPerLine=20; lineH=34; gap=16
  const opts = (vh: number) => ({ viewportHeight: vh, viewportWidth: 400, fontSizePx: 20 });

  function spansOf(seg: any): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    let off = 0;
    for (const t of seg.tokens || []) {
      if (t.type === 'space' || t.type === 'def') continue;
      const raw = typeof t.raw === 'string' ? t.raw : '';
      if (!raw) continue;
      out.push({ start: off, end: off + raw.length });
      off += raw.length;
    }
    return out;
  }

  function mdOf(seg: any): string {
    return (seg.tokens || [])
      .filter((t: any) => t.type !== 'space' && t.type !== 'def' && typeof t.raw === 'string' && t.raw)
      .map((t: any) => t.raw as string)
      .join('');
  }

  function contentLenOf(seg: any): number {
    const sp = spansOf(seg);
    return sp.length ? sp[sp.length - 1]!.end : 0;
  }

  /** 切片链校验: 按页序片序, 每段 from 应从 0 连续到 contentLen */
  function assertChain(segs: any[], pages: any[]): void {
    const cursor = segs.map(() => 0);
    for (const pg of pages) {
      for (const pc of pg.pieces) {
        expect(pc.from).toBe(cursor[pc.segIdx]);
        cursor[pc.segIdx] = pc.to;
      }
    }
    segs.forEach((s, i) => expect(cursor[i]).toBe(contentLenOf(s)));
  }

  function cutsOf(pg: any): number[][] {
    return pg.pieces.map((x: any) => [x.from, x.to]);
  }

  it('① 短段 fast path: 整段一页 single, 渲染直返原文', () => {
    const segs = lexToSegments('# 标题\n\n短内容。');
    expect(segs.length).toBe(1);
    const r = fitSeg(segs as any, opts(300));
    expect(r.pageCount).toBe(1);
    const p = r.pages[0]!;
    expect(p.algorithm).toBe('single');
    expect(p.segIndexes).toEqual([0]);
    expect(cutsOf(p)).toEqual([[0, 10]]);
    expect(p.pieces[0]!.frag).toBe('md');
    expect(p.estimatedHeight).toBe(68);
    expect(p.fillRatio).toBeCloseTo(0.25, 5);
    const html = renderPiece(segs[0] as any, p.pieces[0]!);
    expect(html).toBe(segs[0]!.raw);
    expect(html).toContain('<h1');
  });

  it('② 一段一屏: 两段各自成页, 不共页', () => {
    const md = '# 一\n\n' + '甲内容。'.repeat(32) + '\n\n# 二\n\n' + '甲内容。'.repeat(32);
    const segs = lexToSegments(md);
    expect(segs.length).toBe(2);
    const r = fitSeg(segs as any, opts(400));
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.segIndexes)).toEqual([[0], [1]]);
    expect(r.pages.every((p) => p.algorithm === 'single')).toBe(true);
    expect(cutsOf(r.pages[0]!)).toEqual([[0, 133]]);
    expect(cutsOf(r.pages[1]!)).toEqual([[0, 133]]);
  });

  it('③ 长段切多页: 片界钉死 + 续页标记 + 每片 ≤480 等效字', () => {
    const md = '# 长\n\n' + '这是一句测试文本。'.repeat(167);
    const segs = lexToSegments(md);
    expect(segs.length).toBe(1);
    const r = fitSeg(segs as any, opts(2000));
    expect(r.pageCount).toBe(2);
    const p0 = r.pages[0]!;
    expect(p0.algorithm).toBe('split-para');
    expect(p0.isContinuation).toBeUndefined();
    expect(cutsOf(p0)).toEqual([[0, 5], [5, 482], [482, 959], [959, 1094]]);
    const p1 = r.pages[1]!;
    expect(p1.isContinuation).toBe(true);
    expect(p1.continuationTitle).toBe('长 · 2');
    expect(p1.algorithm).toBe('split-para');
    expect(cutsOf(p1)).toEqual([[1094, 1508]]);
    assertChain(segs as any, r.pages);
    const segMd = mdOf(segs[0]);
    for (const pg of r.pages) {
      for (const pc of pg.pieces) {
        expect(measureEm(segMd.slice(pc.from, pc.to))).toBeLessThanOrEqual(480.5);
      }
    }
  });

  it('③b 无标点超长段: 单步硬切恰 480 字', () => {
    const md = '# 长\n\n' + '字'.repeat(700);
    const segs = lexToSegments(md);
    const r = fitSeg(segs as any, opts(1000));
    expect(r.pageCount).toBe(2);
    expect(cutsOf(r.pages[0]!)).toEqual([[0, 5], [5, 485], [485, 545]]);
    expect(r.pages[0]!.pieces[1]!.to - r.pages[0]!.pieces[1]!.from).toBe(480);
    expect(r.pages[1]!.continuationTitle).toBe('长 · 2');
    expect(cutsOf(r.pages[1]!)).toEqual([[545, 705]]);
    assertChain(segs as any, r.pages);
  });

  it('④ 标题不孤悬: 页尾放不下 [标题+2行] 时整块翻页', () => {
    const md = '# 主标题\n\n' + '段落文字。'.repeat(20) + '\n\n### 小节\n\n短内容。';
    const segs = lexToSegments(md);
    const r = fitSeg(segs as any, opts(270));
    expect(r.pageCount).toBe(2);
    // h3 (片 107..115) 不在 page0, 被推到页首
    expect(cutsOf(r.pages[0]!)).toEqual([[0, 7], [7, 107]]);
    const p1 = r.pages[1]!;
    expect(p1.isContinuation).toBe(true);
    expect(p1.continuationTitle).toBe('主标题 · 2');
    expect(cutsOf(p1)).toEqual([[107, 115], [115, 119]]);
    assertChain(segs as any, r.pages);
  });

  it('⑤ 表格: 按行切分不断行, 续页表头补回', () => {
    const md = '# 表\n\n| 列A | 列B |\n| --- | --- |\n' + '| 甲 | 乙 |\n'.repeat(60);
    const segs = lexToSegments(md);
    const r = fitSeg(segs as any, opts(300));
    expect(r.pageCount).toBe(11);
    expect(r.pages[0]!.algorithm).toBe('split-para');
    expect(r.pages[0]!.pieces.map((x) => [x.from, x.to, x.frag])).toEqual([[0, 5, 'md'], [5, 71, 'table']]);
    const cuts = [[71, 131], [131, 191], [191, 251], [251, 311], [311, 371], [371, 431], [431, 491], [491, 551], [551, 611], [611, 631]];
    for (let i = 0; i < cuts.length; i++) {
      const pg = r.pages[i + 1]!;
      expect(pg.algorithm).toBe('split-table');
      expect(pg.isContinuation).toBe(true);
      expect(cutsOf(pg)).toEqual([cuts[i]]);
    }
    // 续页渲染: 表头 + 分隔线补回, 输出合法 table html
    const html = renderPiece(segs[0] as any, r.pages[1]!.pieces[0]!);
    expect(html).toContain('<thead>');
    expect(html).toContain('列A');
    assertChain(segs as any, r.pages);
  });

  it('⑥ 代码块: 按行切页, 围栏闭合并带语言 (不落字面量围栏)', () => {
    const md = '# 代码\n\n```js\n' + 'const x1 = 1;\n'.repeat(40) + '```';
    const segs = lexToSegments(md);
    const r = fitSeg(segs as any, opts(300));
    expect(r.pageCount).toBe(7);
    expect(r.pages[0]!.pieces.map((x) => [x.from, x.to, x.frag])).toEqual([[0, 6, 'md'], [6, 82, 'code']]);
    const cuts = [[82, 166], [166, 250], [250, 334], [334, 418], [418, 502], [502, 575]];
    for (let i = 0; i < cuts.length; i++) {
      const pg = r.pages[i + 1]!;
      expect(pg.algorithm).toBe('split-code');
      expect(pg.isContinuation).toBe(true);
      expect(cutsOf(pg)).toEqual([cuts[i]]);
    }
    const h0 = renderPiece(segs[0] as any, r.pages[0]!.pieces[1]!);
    expect(h0).toContain('<pre><code class="language-js">');
    expect(h0).not.toContain('```');
    const h1 = renderPiece(segs[0] as any, r.pages[1]!.pieces[0]!);
    expect(h1).toContain('<pre><code class="language-js">');
    expect(h1).not.toContain('```');
    assertChain(segs as any, r.pages);
  });

  it('⑦ measureEm: 中文 1 / 半角 0.5 / 等宽 0.62', () => {
    expect(measureEm('中文')).toBe(2);
    expect(measureEm('ab')).toBe(1);
    expect(measureEm('中文ab')).toBe(3);
    expect(measureEm('ab', true)).toBeCloseTo(1.24, 5);
    expect(measureEm('a b')).toBeCloseTo(1.32, 5);
  });

  it('⑨ 空文档 / 无 token 段: 不产页', () => {
    expect(fitSeg([], opts(300)).pageCount).toBe(0);
    const r = fitSeg([{ raw: '', tokens: [] }] as any, opts(300));
    expect(r.pageCount).toBe(0);
  });
});

describe('anchor', () => {
  it('hash 稳定', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('recover 同段号', () => {
    const segs = [{ text: '段落A' }, { text: '段落B' }];
    const a = makeAnchor(1, '段落B');
    expect(recoverAnchor(a, segs)).toBe(1);
  });

  it('recover 段号失效但 hash 匹配', () => {
    const segs = [{ text: '段落A' }, { text: '段落B-new' }];
    const a = makeAnchor(1, '段落B-old');
    // hash 不匹配，应该返回 -1
    expect(recoverAnchor(a, segs)).toBe(-1);
  });

  it('recover 段号失效 + hash 模糊匹配', () => {
    const segs = [
      { text: '段落A' },
      { text: '段落B' },
      { text: '段落C' },
    ];
    const a = makeAnchor(1, '段落B');
    const idx = recoverAnchor(a, segs);
    // 应该匹配到段号 1
    expect(idx).toBe(1);
  });
});

describe('highlight', () => {
  it('转义特殊字符', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('"hi"')).toBe('&quot;hi&quot;');
  });
});

describe('frontmatter', () => {
  it('解析简单 YAML', () => {
    const md = '---\ntitle: 测试\ncount: 42\n---\n\n# 正文';
    const r = parseFrontmatter(md);
    expect(r.meta.title).toBe('测试');
    expect(r.meta.count).toBe(42);
    expect(r.body).toContain('# 正文');
  });

  it('无 frontmatter', () => {
    const md = '# 直接开始';
    const r = parseFrontmatter(md);
    expect(r.meta).toEqual({});
    expect(r.body).toBe(md);
  });

  it('frontmatter 解析失败容错', () => {
    const md = '---\nbad: yaml: here: :\n---\n# 正文';
    const r = parseFrontmatter(md);
    expect(r.body).toContain('# 正文');
  });
});
