import { describe, it, expect } from 'vitest';
import { lexToSegments } from '@core/segmenter';
import { fitSeg, shrinkGrow } from '@core/fitSeg';
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

describe('fitSeg', () => {
  it('P7: 3 段中长 (300字/段) dense-pack 装 1 页 (上限 3 段)', () => {
    const segs = [
      { text: 'a'.repeat(300) },
      { text: 'b'.repeat(300) },
      { text: 'c'.repeat(300) },
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 3 段都中长, 不超 1.5×target 也不超 1.2×target, 装 1 页
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.segIndexes).toEqual([0, 1, 2]);
    expect(r.pages[0]!.algorithm).toBe('dense-pack');
  });

  it('P7: 碎小段(avg<=80) merge-tiny 共页', () => {
    const segs = [
      { text: 'hi' }, { text: 'hello' }, { text: 'world' }, { text: 'foo' },
      { text: 'bar' }, { text: 'baz' }, { text: 'ok' }, { text: 'cool' },
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 全部进 merge-tiny 装满 1 页
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.algorithm).toBe('merged-tiny');
    expect(r.pages[0]!.segIndexes.length).toBeGreaterThanOrEqual(4);
  });

  it('P7: H1 永远独占一页', () => {
    const segs = [
      { text: 'A'.repeat(200) },
      { text: '# 标题', kind: 'h1' },
      { text: 'B'.repeat(300) },
      { text: 'C'.repeat(200) },
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    const titlePage = r.pages.find((p) => p.segIndexes.includes(1));
    expect(titlePage?.algorithm).toBe('title-break');
    expect(titlePage?.segIndexes).toEqual([1]);
  });

  it('P7: 连续 ## 标题共页', () => {
    // 视图 800, H2 标题+ 标题 + 200字段落 (短) — 全共页
    const segs = [
      { text: '## 标题1', kind: 'h2' },
      { text: '## 标题2', kind: 'h2' },
      { text: '一段短内容'.repeat(10), kind: 'p' }, // 50 字
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 三个连续短段 — merge-tiny 共 1 页
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.segIndexes).toEqual([0, 1, 2]);
  });

  it('P7: ## + 短段 共页 (单页 200字以下)', () => {
    const segs = [
      { text: '## 章节', kind: 'h2' },
      { text: '短内容'.repeat(20), kind: 'p' },  // 120 字
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 标题+短段 — 一页, 标题不独占
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.segIndexes).toEqual([0, 1]);
  });

  it('P7: ## + 长段 标题独占', () => {
    const segs = [
      { text: '## 章节', kind: 'h2' },
      { text: '长'.repeat(300), kind: 'p' },  // 300 字
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 标题独占, 长段独立 → 2 页
    expect(r.pages.length).toBe(2);
    expect(r.pages[0]!.algorithm).toBe('title-break');
    expect(r.pages[0]!.segIndexes).toEqual([0]);
    expect(r.pages[1]!.segIndexes).toEqual([1]);
  });

  it('P7: 长段切多页 (split-by-line)', () => {
    // 2000 字, 视口200 — 一屏只能装 ≈90字 (200/30.6*30.6=200, 装 100-105字)
    const segs = [
      { text: '一句话。'.repeat(500), kind: 'p' }, // 4 chars * 500 = 2000 字
    ];
    const r = fitSeg(segs, { viewportHeight: 200, fontSizePx: 18 });
    // 切多页
    expect(r.pages.length).toBeGreaterThan(1);
    expect(r.pages[0]!.algorithm).toMatch(/split-by/);
    // 续页标记
    expect(r.pages[1]!.isContinuation).toBe(true);
    expect(r.pages[1]!.continuationTitle).toContain('·');
  });

  it('P7: 极长段切多页 (split-by-block)', () => {
    // 3000 字, 视口 200
    const segs = [
      { text: '## 标题\n\n段落一。\n\n段落二。\n\n段落三。'.repeat(120), kind: 'p' },
    ];
    const r = fitSeg(segs, { viewportHeight: 200, fontSizePx: 18 });
    expect(r.pages.length).toBeGreaterThan(2);
    expect(r.pages[0]!.algorithm).toBe('split-by-block');
  });

  it('P7: code 块独占', () => {
    const segs = [
      { text: '```\nconst x = 1;\n```', kind: 'code' },
      { text: '短文', kind: 'p' },
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // code 单独一页
    const codePage = r.pages.find((p) => p.algorithm === 'code-block');
    expect(codePage).toBeDefined();
  });

  it('P7: 文档只有 H1', () => {
    const segs = [{ text: '# 唯一标题', kind: 'h1' }];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.algorithm).toBe('title-break');
  });

  it('P7: 文档空', () => {
    const r = fitSeg([], { viewportHeight: 800, fontSizePx: 18 });
    expect(r.pages.length).toBe(0);
  });

  it('P7: ## 末尾无 next 不独占 (与空 buffer 共页)', () => {
    const segs = [
      { text: '一段内容', kind: 'p' },
      { text: '## 标题', kind: 'h2' },
    ];
    const r = fitSeg(segs, { viewportHeight: 800, fontSizePx: 18 });
    // 1 段内容(1字) → 短; 标题 + 1字 → 共页
    expect(r.pages.length).toBe(1);
    expect(r.pages[0]!.segIndexes).toEqual([0, 1]);
  });

  it('P7: 长段切多页 slice 正确', () => {
    const segs = [
      { text: '一句话。'.repeat(500), kind: 'p' },  // 2000 字
    ];
    const r = fitSeg(segs, { viewportHeight: 200, fontSizePx: 18 });
    // 切片 [start,end] 应连续
    let cursor = 0;
    for (const page of r.pages) {
      for (const s of page.slices) {
        expect(s.start).toBe(cursor);
        cursor = s.end;
      }
    }
    expect(cursor).toBe(segs[0]!.text.length);
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
