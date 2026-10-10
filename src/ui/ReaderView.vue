<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { lexToSegments, type Segment } from '@core/segmenter';
import { fitSeg, renderPiece, type PagePiece } from '@core/fitSeg';
import { makeAnchor } from '@core/anchor';
import { readDocument, resolveRelative, dirOf, fileSrc, pickFile } from '@platform/fs';
import { rewriteImages } from '@core/segmenter';
import { writeBook, writeShelf, readShelf, readBook, writeNotes, readNotes, pushHistory, addBookmark as addBookmarkFn, type ShelfItem, type Book, type NotesDoc, type Highlight, type Anchor } from '@platform/store';
import { exitFullscreen, toggleFullscreen, autoFullscreenForPortrait, rememberBigState, restoreBigState } from '@platform/window';
import HelpModal from './HelpModal.vue';
import Palette from './Palette.vue';

const emit = defineEmits<{
  back: [];
  open: [path: string];
}>();

const props = defineProps<{
  path: string;
}>();

const md = ref('');
const segs = ref<Segment[]>([]);
const pageIdx = ref(0);
const showHelp = ref(false);
const showToc = ref(false);
const showNotes = ref(false);
const showPalette = ref(false);
const doneAll = ref(false);
// T2: 文章容器真实可用高度(测 DOM 而非估算)
const articleRef = ref<HTMLElement | null>(null);
const articleHeight = ref(0);

// T1: 段 div ref — 用于精确包裹高亮
const segRef = ref<HTMLElement | null>(null);
const t0 = ref(0);
const loading = ref(true);
const errorMsg = ref<string | null>(null);
const isFullscreen = ref(false);
const fullscreenLabel = computed(() => (isFullscreen.value ? '退出全屏' : '全屏'));

// D2 划线 / 笔记
const fingerprint = ref('');
const notes = ref<NotesDoc>({ version: 1, fingerprint: '', highlights: [] });

// T1: 字号跟视口走 — 读 body 解析后的实际 px (clamp 字符串 parseFloat 会得 NaN)
//     html 固定 16px (rem 基准), 阅读字号在 body: var(--read-fs)
const fitBase = computed(() => parseFloat(getComputedStyle(document.body).fontSize) || 22);

// v2: .big 切换 / 窗口尺寸变化会改 --read-fs, getComputedStyle 非响应式 — 用 tick 驱动重算
const fsTick = ref(0);
let fsObserver: MutationObserver | null = null;
function bumpFsTick() {
  fsTick.value++;
}

const pages = computed(() => {
  if (!segs.value.length) return [];
  // 依赖 --read-fs 变化信号 (全屏 .big / 尺寸变化)
  void fsTick.value;
  // 左右各 22px (article px-[22px]) → vw - 44; 上下各 8px (py-2) → avail - 16
  const avail = (articleHeight.value || (window.innerHeight - 60)) - 16;
  if (avail <= 0) return [];
  const cs = getComputedStyle(document.documentElement);
  const vw = Math.max(1, (articleRef.value?.clientWidth || window.innerWidth) - 44);
  const result = fitSeg(segs.value as Segment[], {
    viewportHeight: avail,
    viewportWidth: vw,
    fontSizePx: fitBase.value,
    lineHeightRatio: parseFloat(cs.getPropertyValue('--line-h')) || 1.7,
    gapPx: 16,
    maxPieceEm: 480,
  });
  return result.pages;
});

// P7: 当前页 — PageCut
const currentPage = computed(() => pages.value[pageIdx.value]);

// P7: 当前页的段号数组 (扁平) — 模板用
const currentPageSegs = computed(() => currentPage.value?.segIndexes ?? []);

// v2: 字号恒定 (跟 --read-fs), PageCut.fontSize 仅供 debug 显示
const currentFs = computed(() => currentPage.value?.fontSize ?? fitBase.value);

// P7: 当前页算法 — debug
const currentPageAlgo = computed(() => currentPage.value?.algorithm ?? '—');
const currentContinuationTitle = computed(() => currentPage.value?.continuationTitle ?? '');

// T1 + T6: 翻页/划线变化时重新包裹高亮 — 遍历当前页所有段
watch([() => pageIdx.value, () => notes.value.highlights], () => {
  nextTick(() => {
    if (segRef.value) {
      const segIds = currentPageSegs.value;
      if (segIds.length > 0) wrapSegmentHighlights(segRef.value, segIds);
    }
  });
}, { deep: false });

// T2: 右键菜单 — 仿微信读书气泡
interface MenuItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
}
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  const sel = window.getSelection();
  const hasSel = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  // 找当前段
  let segIdx = -1;
  let node: Node | null = e.target as Node;
  while (node && !(node instanceof HTMLElement && node.dataset.segIdx !== undefined)) {
    node = node.parentNode;
  }
  if (node) segIdx = parseInt((node as HTMLElement).dataset.segIdx || '-1', 10);

  const items: MenuItem[] = [];
  if (hasSel) {
    items.push({ id: 'highlight', label: '划线', icon: 'i-lucide-highlighter' });
    items.push({ id: 'note', label: '想法…', icon: 'i-lucide-sticky-note' });
    items.push({ id: 'copy', label: '复制', icon: 'i-lucide-copy' });
  } else {
    items.push({ id: 'bookmark-add', label: '添加书签', icon: 'i-lucide-bookmark' });
  }
  items.push({ id: 'segment-title', label: '段标题', icon: 'i-lucide-heading' });

  // 弹气泡 (靠点击位置, 越界则贴屏幕内)
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - items.length * 32 - 8);
  ctxMenu.value = { x, y, items };
}

async function onCtxMenuPick(id: string) {
  const sel = window.getSelection();
  ctxMenu.value = null;
  if (id === 'highlight') return createHighlight();
  if (id === 'note') return createNote();
  if (id === 'copy') {
    if (sel && !sel.isCollapsed) {
      const text = sel.toString();
      try { await navigator.clipboard.writeText(text); } catch {}
    }
    return;
  }
  if (id === 'bookmark-add') {
    return addBookmark();
  }
  if (id === 'segment-title') {
    // 复制段标题到剪贴板
    const seg = segs.value[pages.value[pageIdx.value]?.segIndexes[0] ?? -1];
    if (seg) {
      try { await navigator.clipboard.writeText(seg.title); } catch {}
    }
  }
}

// P7: currentPage 已在上面定义 (line ~70). 这里不再重复声明.

onMounted(async () => {
  try {
    const result = await readDocument(props.path);
    md.value = result.text;
    segs.value = lexToSegments(result.text);
    t0.value = Date.now();
    // T3: 浏览记录 — 打开
    pushHistory(props.path, 'open').catch(() => {});
    // D2: 加载本档的划线
    fingerprint.value = result.text.length.toString() + ':' + props.path;
    try {
        notes.value = await readNotes(fingerprint.value);
      } catch { notes.value = { version: 1, fingerprint: fingerprint.value, highlights: [] }; }
    loading.value = false;
    // D1-T2: 恢复 cursor——读 book.json, 跳到上次段
    try {
      const last = await readBook();
      if (last && last.path === props.path && last.cursor && last.cursor > 0 && last.cursor < segs.value.length) {
        const targetIdx = last.cursor;
        // 找包含 targetIdx 的页号
        for (let pi = 0; pi < pages.value.length; pi++) {
          if (pages.value[pi]?.segIndexes.includes(targetIdx)) { pageIdx.value = pi; break; }
        }
      }
    } catch { /* book 不存在无所谓 */ }
    // 持久化"当前阅读"
    await saveBook();
  } catch (e) {
    errorMsg.value = String(e);
    loading.value = false;
  }

  // F9: 初始化全屏按钮状态；监听窗口变化以刷新图标
  const win = getCurrentWindow();
  isFullscreen.value = await win.isFullscreen();
  win.onResized(async () => {
    isFullscreen.value = await win.isFullscreen();
  });

  // D3-T1: 监听 watch_event——文件改动重读
  await listen<{ path: string; kind: string; ts: number }>('watch_event', async (e) => {
    if (e.payload.path !== props.path) return;
    if (e.payload.kind === 'remove') {
      errorMsg.value = '源文件被移动或删除';
      return;
    }
    try {
      const result = await readDocument(props.path);
      md.value = result.text;
      segs.value = lexToSegments(result.text);
      // 锚点恢复——保留页号
      const oldSegCount = currentMaxAnchor();
      // 重定位: 若 maxAnchor 段还存在, 留原页; 否则落到首页
      // 简化: 落到首页
      pageIdx.value = 0;
      doneAll.value = false;
    } catch (e2) {
      errorMsg.value = String(e2);
    }
  });

  // 启动 watch
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('start_watch', { path: props.path });
  } catch (e2) { /* ignore */ }
});

async function onToggleFullscreen() {
  await toggleFullscreen();
  isFullscreen.value = await getCurrentWindow().isFullscreen();
}

// T2: 尺寸/方向变化时, 竖屏自动全屏
function onOrientationChange() {
  autoFullscreenForPortrait();
}

// T4: 剪贴板陪读 — 监听系统剪贴板变化(每 1.5s 轮询一次)
//   任何"看起来像 Markdown"的文本出现 → 弹 toast 询问加入阅读
let lastClip = '';
const clipSuggest = ref<{ text: string; ts: number } | null>(null);
async function pollClipboard() {
  try {
    if (!navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText();
    if (!text || text === lastClip) return;
    lastClip = text;
    // 启发: 像 markdown?
    const looksLikeMd = /(^#|\n#|\n## |\n### |```|^\s*[-*+]\s|\|.*\|)/.test(text);
    if (!looksLikeMd || text.length < 30) return;
    clipSuggest.value = { text, ts: Date.now() };
    toastMsg.value = '📋 剪贴板有新内容 — 回车加入阅读';
  } catch { /* 权限被拒/无焦点, 忽略 */ }
}

onUnmounted(async () => {
  // 离开时保存一次
  saveBook();
  // 停 watch
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('stop_watch');
  } catch { /* ignore */ }
});

async function saveBook() {
  if (!md.value) return;
  const book: Book = {
    path: props.path,
    text: md.value,
    cursor: currentPage.value?.segIndexes[0] ?? 0,
  };
  try {
    await writeBook(book);
    // F6: 同步书架——直接走 Tauri 命令，不再借道 localStorage
    const cur = await readShelf();
    const idx = cur.items.findIndex((x) => x.path === props.path);
    const item: ShelfItem = {
      path: props.path,
      title: props.path.split(/[\\/]/).pop() ?? props.path,
      maxAnchor: currentMaxAnchor(),
      totalSegs: segs.value.length,
      dur: 0,
      lastOpen: Date.now(),
    };
    if (idx >= 0) cur.items[idx] = item;
    else cur.items.push(item);
    await writeShelf(cur);
  } catch (e) {
    console.error('saveBook:', e);
  }
}

/**
 * D1-T2: maxAnchor = 当前页内全局段号的最大值。
 * fitSeg.pages[i] 里存的本来就是全局段号，currentPage.value 是当前页的全局段号数组。
 */
function currentMaxAnchor(): number {
  if (!currentPage.value || currentPage.value.segIndexes.length === 0) return 0;
  return Math.max(...currentPage.value.segIndexes);
}

function next() {
  if (pageIdx.value < pages.value.length - 1) {
    pageIdx.value++;
    saveBook();
  } else {
    // D2 完成态: 末段下一行 → 触发 doneAll
    doneAll.value = true;
  }
}

function prev() {
  if (doneAll.value) { doneAll.value = false; return; }
  if (pageIdx.value > 0) {
    pageIdx.value--;
    saveBook();
  }
}

function restart() {
  doneAll.value = false;
  pageIdx.value = 0;
}

function fmtElapsed(): string {
  if (!t0.value) return '';
  const sec = Math.floor((Date.now() - t0.value) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} 分 ${s} 秒`;
}

function goToc() {
  showToc.value = !showToc.value;
}

function onKeydown(e: KeyboardEvent) {
  // T4: 快捷键 — 让阅读屏始终收键
  // 即使焦点在 contenteditable / 普通 div, 也让快捷键生效
  // (不阻止正常输入框输入)
  if (e.key === 'Escape') {
    if (showHelp.value) {
      showHelp.value = false;
      e.preventDefault();
      return;
    }
    if (showToc.value) {
      showToc.value = false;
      e.preventDefault();
      return;
    }
    exitFullscreen();
    e.preventDefault();
    return;
  }

  // q = 关模态（冗余）
  if (e.key === 'q' && (showHelp.value || showToc.value)) {
    showHelp.value = false;
    showToc.value = false;
    e.preventDefault();
    return;
  }

  // 阅读键
  if (e.target instanceof HTMLInputElement) return;
  // T4: 剪贴板建议在时, Enter 接收
  if (e.key === 'Enter' && clipSuggest.value) {
    openFromClipboard();
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') {
    next();
    e.preventDefault();
  } else if (e.key === 'ArrowLeft') {
    prev();
    e.preventDefault();
  } else if (e.key === '?') {
    showHelp.value = !showHelp.value;
    e.preventDefault();
  } else if (e.key === 't') {
    goToc();
    e.preventDefault();
  } else if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
    showNotes.value = !showNotes.value;
    e.preventDefault();
  } else if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
    emit('back');
    e.preventDefault();
  } else if (e.key === 'h') {
    createHighlight();
    e.preventDefault();
  } else if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
    showPalette.value = !showPalette.value;
    e.preventDefault();
  } else if (e.key === 'f' && (e.ctrlKey || e.metaKey) && e.altKey) {
    // Q4: Ctrl+Alt+F 切换字体
    cycleFontFamily();
    e.preventDefault();
  } else if (e.key === 'Enter' && clipSuggest.value) {
    // T4: 回车接收剪贴板建议
    openFromClipboard();
  }
}

// T4: 把剪贴板内容写到临时 md 并打开
async function openFromClipboard() {
  if (!clipSuggest.value) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const tmpPath = await invoke<string>('open_clipboard_doc', { text: clipSuggest.value.text });
    clipSuggest.value = null;
    toastMsg.value = '';
    emit('open', tmpPath);
  } catch (e) {
    toastMsg.value = `剪贴板打开失败：${String(e)}`;
  }
}

async function onPaletteAction(id: string) {
  switch (id) {
    case 'open': {
      const p = await pickFile();
      if (p) emit('open', p);
      break;
    }
    case 'theme-light': setTheme('light'); break;
    case 'theme-sepia': setTheme('sepia'); break;
    case 'theme-dark': setTheme('dark'); break;
    case 'toggle-fullscreen': await onToggleFullscreen(); break;
    case 'back-to-shelf': emit('back'); break;
    case 'show-help': showHelp.value = true; break;
    case 'show-toc': showToc.value = true; break;
    case 'show-notes': showNotes.value = true; break;
    case 'restart': restart(); break;
    case 'search': showPalette.value = true; break;
  }
}

async function setTheme(t: 'light' | 'sepia' | 'dark') {
  document.documentElement.setAttribute('data-theme', t);
  try {
    const { readPrefs, writePrefs } = await import('@platform/store');
    const p = await readPrefs();
    await writePrefs({ ...p, theme: t });
  } catch { /* ignore */ }
}

// Q4: 字体循环 — lxgw(霞鹜文楷) → songti(思源宋体) → system(系统衬线) → lxgw
const FONT_CYCLE: Array<{ id: 'lxgw' | 'songti' | 'system'; label: string }> = [
  { id: 'lxgw', label: '霞鹜文楷' },
  { id: 'songti', label: '思源宋体' },
  { id: 'system', label: '系统衬线' },
];

async function cycleFontFamily() {
  const cur = document.documentElement.getAttribute('data-font') || 'lxgw';
  const i = FONT_CYCLE.findIndex((f) => f.id === cur);
  const next = FONT_CYCLE[(i + 1) % FONT_CYCLE.length]!;
  document.documentElement.setAttribute('data-font', next.id);
  try {
    const { readPrefs, writePrefs } = await import('@platform/store');
    const p = await readPrefs();
    await writePrefs({ ...p, fontFamily: next.id });
  } catch { /* ignore */ }
}

const fontLabel = computed(() => {
  const cur = document.documentElement.getAttribute('data-font') || 'lxgw';
  return FONT_CYCLE.find((f) => f.id === cur)?.label ?? '字体';
});

onMounted(() => {
  // T4: capture phase — 抢先于任何内部 stopPropagation
  window.addEventListener('keydown', onKeydown, { capture: true });
  // T2: ResizeObserver 测 article 实际可用高度 — 避免 innerHeight 估算偏差
  if (articleRef.value) {
    articleHeight.value = articleRef.value.clientHeight;
    const ro = new ResizeObserver(() => {
      if (articleRef.value) articleHeight.value = articleRef.value.clientHeight;
    });
    ro.observe(articleRef.value);
    onUnmounted(() => ro.disconnect());
  }
  // D2 修复: mouseup 时缓存选区段号, 让 h 键能可靠地工作
  window.addEventListener('mouseup', onArticleMouseUp);
  // T2: 右键菜单外点击关闭
  window.addEventListener('click', () => { ctxMenu.value = null; });
  // T2: 记录进入阅读前的全屏状态 — 退出时还原
  rememberBigState();
  // T2: 进入阅读屏时 — 竖屏自动全屏
  autoFullscreenForPortrait();
  // T2: 监听窗口尺寸变化 — 变成竖屏就全屏, 横屏不动
  window.addEventListener('resize', onOrientationChange);
  // v2: .big 切换 (syncBigClass 改 html class) / 尺寸变化 → 重算分页
  fsObserver = new MutationObserver(bumpFsTick);
  fsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', bumpFsTick);
  // T4: 剪贴板陪读 — 1.5s 轮询
  const clipTimer = window.setInterval(pollClipboard, 1500);
  onUnmounted(() => clearInterval(clipTimer));
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true });
  window.removeEventListener('mouseup', onArticleMouseUp);
  window.removeEventListener('resize', onOrientationChange);
  window.removeEventListener('resize', bumpFsTick);
  fsObserver?.disconnect();
  fsObserver = null;
  // T2: 离开阅读屏 — 还原全屏状态
  restoreBigState().catch(() => {});
});

/**
 * P7 v2: 按 PagePiece [from, to] 渲染 (md 偏移, token 级切割).
 * D3: 相对图片重写; data-seg-idx 供 h 键 / 右键菜单 / 高亮包裹定位.
 */
function renderPieceWithImages(p: PagePiece): string {
  const seg = segs.value[p.segIdx];
  if (!seg) return '';
  const html = renderPiece(seg, p);
  if (!html) return '';
  const base = dirOf(props.path);
  return `<div data-seg-idx="${seg.index}">${rewriteImages(html, base, fileSrc)}</div>`;
}

/**
 * T1 + T6: 精确包裹高亮 — 遍历段内文本节点, 包 <u class="pd-hl">
 * - 新的 (有 segRange): 按字符偏移精确包
 * - 老的 (无 segRange): 在该段内文本搜索 (回退)
 * 不影响段高 (Web 版 §9.3 红线: <u> 不能加 padding/margin/border).
 */
function wrapSegmentHighlights(root: HTMLElement, segIdxList: number[]) {
  for (const segIdx of segIdxList) {
    // 找该 segIdx 对应的 div (data-seg-idx)
    const segDiv = root.querySelector(`[data-seg-idx="${segIdx}"]`) as HTMLElement | null;
    if (!segDiv) continue;
    const segHighlights = notes.value.highlights.filter((h) => h.anchor.idx === segIdx);
    if (segHighlights.length === 0) continue;

    // 收集该段内的文本节点
    const walker = document.createTreeWalker(segDiv, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // 跳过已有的 <u> 内部文本
        let p = node.parentNode;
        while (p && p !== segDiv) {
          if (p.nodeName === 'U' || (p as HTMLElement).classList?.contains('pd-hl')) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let n = walker.nextNode();
    while (n) {
      textNodes.push(n as Text);
      n = walker.nextNode();
    }
    if (textNodes.length === 0) continue;

    for (const h of segHighlights) {
      if (h.segRange && h.segRange.length > 0) {
        // T6: 精确包 — 取该段内的 Range, 按字符偏移
        const segRange = h.segRange.find((r) => r.segIdx === segIdx);
        if (segRange) {
          wrapSliceInNodes(textNodes, segRange.start, segRange.end);
        }
      } else {
        // Fallback: 文本搜索 (老数据)
        wrapHighlightInNodes(textNodes, h.text);
      }
    }
  }
}

/**
 * T6: 按字符偏移精确包 [start, end) — 在一组文本节点中.
 */
function wrapSliceInNodes(
  nodes: Text[],
  targetStart: number,
  targetEnd: number,
) {
  let cursor = 0;
  for (const node of nodes) {
    const txt = node.textContent || '';
    const nodeStart = cursor;
    const nodeEnd = cursor + txt.length;
    if (nodeEnd <= targetStart) { cursor = nodeEnd; continue; }
    if (nodeStart >= targetEnd) break;
    const localStart = Math.max(0, targetStart - nodeStart);
    const localEnd = Math.min(txt.length, targetEnd - nodeStart);
    if (localEnd <= localStart) { cursor = nodeEnd; continue; }
    const range = document.createRange();
    range.setStart(node, localStart);
    range.setEnd(node, localEnd);
    const u = document.createElement('u');
    u.className = 'pd-hl';
    try {
      range.surroundContents(u);
    } catch {
      const frag = range.extractContents();
      u.appendChild(frag);
      range.insertNode(u);
    }
    cursor = nodeEnd;
  }
}

/**
 * 在一组文本节点中找子串并包 <u>. 跨节点匹配: 从 node[i] 起始若不完整, 跨 i+1 继续.
 */
function wrapHighlightInNodes(nodes: Text[], needle: string) {
  if (!needle || !nodes.length) return;
  // 合并文本 + 索引映射
  let concat = '';
  const map: Array<{ node: Text; start: number; end: number }> = [];
  for (const node of nodes) {
    const txt = node.textContent || '';
    map.push({ node, start: concat.length, end: concat.length + txt.length });
    concat += txt;
  }

  // 找所有出现位置
  let idx = concat.indexOf(needle);
  while (idx !== -1) {
    const end = idx + needle.length;
    wrapRange(nodes, map, idx, end);
    idx = concat.indexOf(needle, end);
  }
}

/**
 * 将 [start, end) 区间跨文本节点包 <u class="pd-hl">.
 */
function wrapRange(
  nodes: Text[],
  map: Array<{ node: Text; start: number; end: number }>,
  start: number,
  end: number,
) {
  for (let i = 0; i < map.length; i++) {
    const { node, start: ns, end: ne } = map[i]!;
    if (ne <= start || ns >= end) continue;
    const localStart = Math.max(0, start - ns);
    const localEnd = Math.min(node.textContent!.length, end - ns);

    // 创建范围
    const range = document.createRange();
    range.setStart(node, localStart);
    range.setEnd(node, localEnd);

    // 包 <u>
    const u = document.createElement('u');
    u.className = 'pd-hl';
    try {
      range.surroundContents(u);
    } catch {
      // 跨元素 — 拆 range: 先包 start 到节点末, 再包后续节点, 最后包剩余
      // 这种情况下 surroundContents 会抛错; 用 extractContents + insertNode 替代
      const frag = range.extractContents();
      u.appendChild(frag);
      range.insertNode(u);
    }
  }
}

/**
 * D2 修复: 缓存当前选中文本的段号与文本。
 * mouseup 触发——避免依赖 window.getSelection() 在 h 键按下时返回空。
 * T6: 同时缓存 segRange (选区在 seg.text 中的字符偏移)
 */
import type { HighlightSegRange } from '@platform/store';
const lastSelSeg = ref<number>(-1);
const lastSelText = ref<string>('');
const lastSelRange = ref<HighlightSegRange | null>(null);
function onArticleMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    lastSelSeg.value = -1; lastSelText.value = ''; lastSelRange.value = null; return;
  }
  const range = sel.getRangeAt(0);
  // 找 segIdx
  let node: Node | null = sel.anchorNode;
  while (node && !(node instanceof HTMLElement && node.dataset.segIdx !== undefined)) {
    node = node.parentNode;
  }
  if (!node) { lastSelSeg.value = -1; lastSelText.value = ''; lastSelRange.value = null; return; }
  const segIdx = parseInt((node as HTMLElement).dataset.segIdx || '-1', 10);
  const text = sel.toString().trim();
  // T6: 算 start/end 在 seg.text 中的字符偏移
  // 用 seg div 的 textContent 来定位, 但 seg div 里的 html 已被包了 data-seg-idx
  // 用 seg.text (marked 后的 plain) 不准确, 因为 wrap 之后会变
  // 实际: 选区是 seg div 内的子节点 — 计算选区文本在 seg div.textContent 中的偏移
  const segDiv = node as HTMLElement;
  const segText = segDiv.textContent ?? text;
  const beforeRange = document.createRange();
  beforeRange.setStart(segDiv, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const start = beforeRange.toString().length;
  const end = start + text.length;
  lastSelSeg.value = segIdx;
  lastSelText.value = text;
  lastSelRange.value = { segIdx, start, end };
  // 防止 segText 取错 — start/end 仍能定位
  void segText;
}

/**
 * D2: 创建一条划线——选中文本后按 h 或右键
 * D2 修复: 用 mouseup 缓存的 lastSelSeg/lastSelText (比读 sel 更稳)。
 */
async function createHighlight() {
  if (lastSelSeg.value < 0 || !lastSelText.value) return;
  const segIdx = lastSelSeg.value;
  const text = lastSelText.value;
  const segText = segs.value[segIdx]?.text ?? text;
  const a: Anchor = makeAnchor(segIdx, segText);
  const h: Highlight = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    anchor: a,
    text,
    color: '#fff7d6',
    note: null,
    created_at: Date.now(),
    // T6: 存精确位置 — 用于跨段/多段高亮, 老数据无字段 fallback 文本搜索
    segRange: lastSelRange.value ? [lastSelRange.value] : undefined,
  };
  notes.value.highlights.push(h);
  await writeNotes(fingerprint.value, notes.value);
  // T3: 划线历史
  pushHistory(props.path, 'highlight').catch(() => {});
  // 清选区
  const sel = window.getSelection();
  sel?.removeAllRanges();
  lastSelSeg.value = -1;
  lastSelText.value = '';
  lastSelRange.value = null;
}

/** T2: 创建想法 — 选中文本后弹输入 */
const noteText = ref('');
const noteSegIdx = ref(-1);
const noteSelText = ref('');
const showNoteInput = ref(false);

function createNote() {
  if (lastSelSeg.value < 0 || !lastSelText.value) return;
  noteSegIdx.value = lastSelSeg.value;
  noteSelText.value = lastSelText.value;
  noteText.value = '';
  showNoteInput.value = true;
}

async function saveNote() {
  if (noteSegIdx.value < 0) return;
  const text = noteSelText.value;
  const segText = segs.value[noteSegIdx.value]?.text ?? text;
  const a: Anchor = makeAnchor(noteSegIdx.value, segText);
  const h: Highlight = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    anchor: a,
    text,
    color: '#fff7d6',
    note: noteText.value || null,
    created_at: Date.now(),
    // T6: 想法也存精确位置
    segRange: lastSelRange.value ? [lastSelRange.value] : undefined,
  };
  notes.value.highlights.push(h);
  await writeNotes(fingerprint.value, notes.value);
  pushHistory(props.path, 'highlight').catch(() => {});
  showNoteInput.value = false;
  noteText.value = '';
  const sel = window.getSelection();
  sel?.removeAllRanges();
  lastSelSeg.value = -1;
  lastSelText.value = '';
  lastSelRange.value = null;
}

// T3: 添加书签 — 当前段
const toastMsg = ref('');
async function addBookmark() {
  const segIdx = pages.value[pageIdx.value]?.segIndexes[0] ?? -1;
  if (segIdx < 0) return;
  const seg = segs.value[segIdx];
  if (!seg) return;
  try {
    await addBookmarkFn(props.path, seg.title || `${segIdx + 1} 段`, segIdx);
    toastMsg.value = '已添加书签';
    setTimeout(() => { if (toastMsg.value === '已添加书签') toastMsg.value = ''; }, 2000);
  } catch (e) {
    toastMsg.value = `添加失败：${e}`;
  }
}

// alias 避免 import 重名
// import { addBookmark as addBookmarkFn } from '@platform/store'; // moved to top

async function deleteHighlight(id: string) {
  notes.value.highlights = notes.value.highlights.filter((h) => h.id !== id);
  await writeNotes(fingerprint.value, notes.value);
}

/**
 * D3-T2: 点击 md 链接打开相对路径。维护阅读栈以便返回。
 */
const readingStack = ref<string[]>([]);
function onArticleClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest('a');
  if (!target) return;
  const href = target.getAttribute('href') || '';
  if (!href || href.startsWith('http') || href.startsWith('#')) return;
  // 仅处理 .md / .markdown / .txt 链接
  if (!/\.(md|markdown|txt)$/i.test(href)) return;
  e.preventDefault();
  const base = dirOf(props.path);
  const newPath = resolveRelative(base, href);
  readingStack.value.push(props.path);
  emit('open', newPath);
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <header class="flex items-center justify-between px-4 py-2 border-b border-pd-border text-sm">
      <button class="pd-icon" @click="emit('back')" title="返回书架 (Ctrl+B)">
        <span class="i-lucide-arrow-left" />
      </button>
      <span class="text-pd-dim truncate">
        {{ path.split(/[\\/]/).pop() }} · {{ pageIdx + 1 }} / {{ pages.length }}
      </span>
      <div class="flex gap-1">
        <button class="pd-icon" @click="onToggleFullscreen" :title="fullscreenLabel">
          <span :class="isFullscreen ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" />
        </button>
        <button class="pd-icon" @click="goToc" title="目录 (t)"><span class="i-lucide-list" /></button>
        <button class="pd-icon" @click="showNotes = !showNotes" title="笔记 (Ctrl+N)">
          <span class="i-lucide-sticky-note" />
          <span v-if="notes.highlights.length" class="ml-1 text-xs">{{ notes.highlights.length }}</span>
        </button>
        <!-- Q4: 字体切换 -->
        <button class="pd-icon" @click="cycleFontFamily" :title="`字体：${fontLabel} (Ctrl+Alt+F)`" :aria-label="fontLabel">
          <span class="i-lucide-a-large-small" />
        </button>
        <button class="pd-icon" @click="showHelp = true" title="帮助 (?)"><span class="i-lucide-help-circle" /></button>
      </div>
    </header>

    <div v-if="loading" class="flex-1 flex items-center justify-center text-pd-dim">
      加载中…
    </div>

    <div v-else-if="errorMsg" class="flex-1 flex items-center justify-center text-red-500">
      {{ errorMsg }}
    </div>

    <!-- D2 完成态 -->
    <div v-else-if="doneAll" class="flex-1 flex flex-col items-center justify-center text-center p-8">
      <div class="text-6xl mb-4">🎉</div>
      <h2 class="text-2xl font-bold mb-2">《{{ path.split(/[\\/]/).pop() }}》读完了</h2>
      <p class="text-pd-dim mb-2">{{ pages.length }} 页 · 用时 {{ fmtElapsed() }}</p>
      <p class="text-pd-dim mb-6">{{ segs.length }} 段 · {{ notes.highlights.length }} 处划线</p>
      <div class="flex gap-3">
        <button class="btn-primary" @click="restart">
          <span class="i-lucide-refresh-cw" /> 从头再读
        </button>
        <button class="btn" @click="emit('back')">
          <span class="i-lucide-corner-up-left" /> 换一篇
        </button>
      </div>
    </div>

    <!-- P3: 一段一屏 + fitSeg 纯切割分页 -->
    <article
      v-else
      ref="articleRef"
      class="flex-1 overflow-hidden px-[22px] py-2"
      @click="onArticleClick"
      @contextmenu.prevent="onContextMenu($event)"
    >
      <!-- D 切割引擎 — flex-col 让多段竖排, items-start 顶部对齐, overflow-hidden 不滚 -->
      <div
        ref="segRef"
        class="h-full overflow-hidden px-0 py-0 seg-single flex flex-col items-start justify-start gap-[16px]"
      >
        <!-- 续页标题 (split 多页时显示) -->
        <div v-if="currentContinuationTitle" class="text-pd-dim text-[12px] mb-2 italic">
          《{{ currentContinuationTitle }}》
        </div>
        <div
          v-for="(piece, i) in (currentPage?.pieces ?? [])"
          :key="`${pageIdx}-${piece.segIdx}-${piece.from}`"
          :class="i > 0 ? 'mt-4' : ''"
          :data-seg-idx="piece.segIdx"
          v-html="renderPieceWithImages(piece)"
        />
        <!-- 算法标识 (debug) -->
        <div class="fixed bottom-2 right-2 text-[10px] text-pd-dim opacity-50 select-none pointer-events-none">
          algo: {{ currentPageAlgo }} · {{ currentPage?.pieces.length ?? 0 }} 片/页 · {{ Math.round(currentFs) }}px
        </div>
      </div>
    </article>

    <!-- 目录 -->
    <div v-if="showToc" class="modal-backdrop" @click.self="showToc = false">
      <div class="modal-card max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">目录</h3>
          <button class="btn" @click="showToc = false"><span class="i-lucide-x" /></button>
        </div>
        <ul>
          <li
            v-for="(s, i) in segs.filter((x) => x.kind.startsWith('h'))"
            :key="i"
            class="toc-item"
            @click="pageIdx = Math.floor(i / Math.max(pages.length, 1)); showToc = false"
          >
            <span :class="['ml-' + ((s.kind.charCodeAt(1) - 48) * 2)]" />
            {{ s.text }}<span v-if="s.cont > 1" class="text-pd-dim"> · {{ s.cont }}</span>
          </li>
        </ul>
      </div>
    </div>

    <HelpModal v-if="showHelp" @close="showHelp = false" />
    <Palette v-if="showPalette" @close="showPalette = false" @action="onPaletteAction" />

    <!-- 笔记面板 -->
    <div v-if="showNotes" class="modal-backdrop" @click.self="showNotes = false">
      <div class="modal-card max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">笔记（{{ notes.highlights.length }}）</h3>
          <button class="btn" @click="showNotes = false"><span class="i-lucide-x" /></button>
        </div>
        <div v-if="notes.highlights.length === 0" class="text-pd-dim text-sm">
          还没有笔记。选中文本后按 <kbd>h</kbd> 创建划线。
        </div>
        <ul v-else class="space-y-3">
          <li v-for="h in notes.highlights" :key="h.id" class="border border-pd-border rounded p-3">
            <div class="text-sm text-pd-fg">"{{ h.text }}"</div>
            <div v-if="h.note" class="text-xs text-pd-dim mt-1 italic">💭 {{ h.note }}</div>
            <div class="flex items-center justify-between mt-2 text-xs text-pd-dim">
              <span>段 #{{ h.anchor.idx + 1 }}</span>
              <button class="text-red-500 hover:underline" @click="deleteHighlight(h.id)">删除</button>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- T2: 想法输入 -->
    <div v-if="showNoteInput" class="modal-backdrop" @click.self="showNoteInput = false">
      <div class="modal-card max-w-lg">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-bold">
            <span class="i-lucide-sticky-note text-pd-acc mr-2" />
            添加想法
          </h3>
          <button class="pd-icon" @click="showNoteInput = false"><span class="i-lucide-x" /></button>
        </div>
        <div class="text-sm text-pd-dim mb-2 italic">"{{ noteSelText }}"</div>
        <textarea
          v-model="noteText"
          placeholder="写下你的想法…(Ctrl+Enter 保存)"
          class="w-full min-h-[100px] bg-pd-bg border border-pd-border rounded p-2 text-[14px] text-pd-fg resize-y"
          @keydown.ctrl.enter="saveNote"
        />
        <div class="mt-3 flex gap-2 justify-end">
          <button class="btn" @click="showNoteInput = false">取消</button>
          <button class="btn-primary" @click="saveNote" :disabled="!noteText.trim()">
            <span class="i-lucide-check" /> 保存
          </button>
        </div>
      </div>
    </div>

    <!-- T2: 右键菜单气泡 — 微信读书风格 -->
    <div
      v-if="ctxMenu"
      class="fixed z-50 min-w-[160px] bg-pd-bg border border-pd-border rounded-lg shadow-2xl py-1"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button
        v-for="item in ctxMenu.items"
        :key="item.id"
        class="w-full px-3 py-2 text-left text-[14px] hover:bg-pd-border/40 flex items-center gap-2"
        :class="item.danger ? 'text-red-500' : ''"
        @click="onCtxMenuPick(item.id)"
      >
        <span :class="item.icon" /> {{ item.label }}
      </button>
    </div>

    <!-- T3: Toast 提示 -->
    <Transition name="toast">
      <div
        v-if="toastMsg"
        class="fixed bottom-8 left-1/2 -translate-x-1/2 bg-pd-fg text-pd-bg px-4 py-2 rounded-lg shadow-lg text-[14px]"
      >
        {{ toastMsg }}
      </div>
    </Transition>
  </div>
</template>
