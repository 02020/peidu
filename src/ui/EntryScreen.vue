<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { readShelf, readBook, writeShelf, readPrefs, writePrefs, listHistory, scanInbox, readPreview, copyPreview, savePaste, listPastes, deletePaste, listBookmarks, deleteBookmark, removeHistoryEntry, clearHistory, type ShelfItem, type Book, type InboxItem, type HistoryEntry, type PasteItem, type Bookmark } from '@platform/store';
import { pickFile, pickFolder, loadFolderTree, type FolderNode } from '@platform/fs';
import HelpModal from './HelpModal.vue';
import FolderTree from './FolderTree.vue';

const emit = defineEmits<{
  open: [path: string];
}>();

const shelf = ref<ShelfItem[]>([]);
const lastBook = ref<Book | null>(null);
const showHelp = ref(false);
const showSettings = ref(false);
const errorMsg = ref<string | null>(null);
const currentTheme = ref<'light' | 'sepia' | 'dark'>('sepia');
const showInbox = ref(false);
const inboxItems = ref<InboxItem[]>([]);

// P3: Tab 标签
type TabId = 'folder' | 'history' | 'paste' | 'bookmark';
const activeTab = ref<TabId>('folder');
const tabs = computed(() => [
  { id: 'folder' as TabId, label: '文件夹', icon: 'i-lucide-folder-open', count: folderTree.value ? 1 : 0 },
  { id: 'history' as TabId, label: '浏览记录', icon: 'i-lucide-history', count: history.value.length },
  { id: 'paste' as TabId, label: '粘贴', icon: 'i-lucide-clipboard-paste', count: pastes.value.length },
  { id: 'bookmark' as TabId, label: '书签', icon: 'i-lucide-bookmark', count: bookmarks.value.length },
]);
const hasAnyList = computed(() =>
  folderTree.value !== null || history.value.length > 0 ||
  pastes.value.length > 0 || bookmarks.value.length > 0,
);
const inboxPath = ref<string | null>(null);

// T2: 目录树
const folderTree = ref<FolderNode | null>(null);
// T3: 最近文件夹路径列表 (启动时自动加载最后一个)
const lastFolderPaths = ref<string[]>([]);
// T3: 浏览记录
const history = ref<HistoryEntry[]>([]);

// T5: 复制预览
const previewText = ref<string | null>(null);
const previewPath = ref<string | null>(null);

// T3: 粘贴预览保存列表
const pastes = ref<PasteItem[]>([]);

// T3: 书签
const bookmarks = ref<Bookmark[]>([]);
async function refreshBookmarks() {
  try {
    bookmarks.value = (await listBookmarks()).sort((a, b) => b.ts - a.ts);
  } catch { /* noop */ }
}
async function removeBookmark(id: string) {
  try {
    await deleteBookmark(id);
    await refreshBookmarks();
  } catch (e) {
    errorMsg.value = `删除失败：${String(e)}`;
  }
}

// T6: 笔记库 — 跨文档展示所有划线/想法
const showNotesLib = ref(false);
interface NoteLibItem {
  path: string;
  title: string;
  text: string;
  note: string | null;
  ts: number;
  color: string;
}
const notesLib = ref<NoteLibItem[]>([]);
async function loadNotesLib() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    notesLib.value = await invoke<NoteLibItem[]>('list_all_notes');
  } catch (e) {
    errorMsg.value = `加载笔记失败：${String(e)}`;
  }
}

async function showPreview(item: ShelfItem) {
  try {
    const text = await readPreview(item.path, 200);
    previewText.value = text;
    previewPath.value = item.path;
  } catch (e) {
    errorMsg.value = `读取预览失败：${String(e)}`;
  }
}

async function copyPreviewOf(item: ShelfItem) {
  await copyPreview(item.path, 200).catch((e) => { errorMsg.value = `复制失败：${e}`; });
}

async function openInbox() {
  if (!inboxPath.value) {
    errorMsg.value = '收件箱路径未设置。prefs.inboxPath = null。请在 settings 面板设置。';
    return;
  }
  const ignored = currentPrefs.value?.inboxIgnored ?? [];
  const r = await scanInbox({ inboxPath: inboxPath.value, inboxIgnored: ignored });
  inboxItems.value = r.items;
  showInbox.value = true;
}
const currentPrefs = ref<{ theme: string; inboxPath: string | null; inboxIgnored: string[] } | null>(null);

async function cycleTheme() {
  const order: Array<'light' | 'sepia' | 'dark'> = ['light', 'sepia', 'dark'];
  const i = order.indexOf(currentTheme.value);
  currentTheme.value = order[(i + 1) % order.length]!;
  document.documentElement.setAttribute('data-theme', currentTheme.value);
  try {
    const p = await readPrefs();
    await writePrefs({ ...p, theme: currentTheme.value });
  } catch { /* ignore */ }
}

const hasShelf = computed(() => shelf.value.length > 0);
const hasLastBook = computed(
  () => lastBook.value !== null && lastBook.value.text.length > 0,
);
const lastBookTitle = computed(() => {
  const b = lastBook.value;
  if (!b) return '';
  return b.path.split(/[\\/]/).pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? b.path;
});

onMounted(async () => {
  try {
    const [s, b, p] = await Promise.all([readShelf(), readBook(), readPrefs()]);
    shelf.value = s.items
      .sort((a, b) => b.lastOpen - a.lastOpen)
      .slice(0, 20);
    lastBook.value = b;
    currentTheme.value = p.theme;
    inboxPath.value = p.inboxPath;
    currentPrefs.value = { theme: p.theme, inboxPath: p.inboxPath, inboxIgnored: p.inboxIgnored ?? [] };
    document.documentElement.setAttribute('data-theme', p.theme);
    // T3: 加载最近文件夹列表(back-compat: 老数据 lastFolderPath 单字段迁移)
    const oldSingle = (p as any).lastFolderPath as string | null | undefined;
    lastFolderPaths.value = Array.isArray(p.lastFolderPaths)
      ? p.lastFolderPaths
      : (oldSingle ? [oldSingle] : []);
    // T3: 启动时自动加载最后一个最近文件夹
    const last = lastFolderPaths.value[lastFolderPaths.value.length - 1];
    if (last) {
      try {
        const tree = await loadFolderTree(last);
        folderTree.value = tree;
      } catch { /* 文件夹可能已删除, 忽略 */ }
    }
  } catch (e) {
    console.error('Failed to read shelf/book:', e);
  }
  // T3: 加载浏览记录
  try {
    history.value = (await listHistory()).slice(0, 100);
  } catch { /* noop */ }
  // T3: 加载粘贴列表
  await refreshPastes();
  // T3: 加载书签
  await refreshBookmarks();
  // T6: 加载笔记库(各文档的 notes.json 聚合)
  await loadNotesLib();
  // P3: 自动选第一个有内容的 tab
  if (folderTree.value) activeTab.value = 'folder';
  else if (history.value.length > 0) activeTab.value = 'history';
  else if (bookmarks.value.length > 0) activeTab.value = 'bookmark';
  else if (pastes.value.length > 0) activeTab.value = 'paste';
});

async function onPickFile() {
  try {
    const path = await pickFile();
    if (path) emit('open', path);
  } catch (e) {
    errorMsg.value = `打开文件失败：${String(e)}`;
  }
}

// Q2: 选文件夹 — Tauri 原生对话框
async function triggerFolderPicker() {
  try {
    const path = await pickFolder();
    if (path) {
      folderTree.value = await loadFolderTree(path);
      // T3: 记住路径(push 到最近列表, 去重, 保留全部 5 个)
      const existing = lastFolderPaths.value.filter((p) => p !== path);
      const next = [...existing, path].slice(-5);
      lastFolderPaths.value = next;
      const prefs = await readPrefs();
      await writePrefs({ ...prefs, lastFolderPaths: next });
    }
  } catch (e) {
    errorMsg.value = `选文件夹失败：${String(e)}`;
  }
}

// T3: 切换到指定历史文件夹
async function switchToFolder(path: string) {
  try {
    folderTree.value = await loadFolderTree(path);
    // 移到最后
    const existing = lastFolderPaths.value.filter((p) => p !== path);
    const next = [...existing, path].slice(-5);
    lastFolderPaths.value = next;
    const prefs = await readPrefs();
    await writePrefs({ ...prefs, lastFolderPaths: next });
  } catch (e) {
    errorMsg.value = `切换失败：${String(e)}`;
  }
}

async function removeRecentFolder(path: string) {
  lastFolderPaths.value = lastFolderPaths.value.filter((p) => p !== path);
  const prefs = await readPrefs();
  await writePrefs({ ...prefs, lastFolderPaths: lastFolderPaths.value });
}

function openItem(item: ShelfItem) {
  emit('open', item.path);
}

async function removeItem(item: ShelfItem) {
  const cur = await readShelf();
  const filtered = cur.items.filter((x) => x.path !== item.path);
  await writeShelf({ ...cur, items: filtered });
  shelf.value = filtered.sort((a, b) => b.lastOpen - a.lastOpen).slice(0, 20);
}

// P2: 粘贴预览 — 不依赖书架, 任意位置都可以
const showPaste = ref(false);
const pasteText = ref('');
const pastePreview = ref('');
async function onPastePreview() {
  const text = pasteText.value.trim();
  if (!text) {
    errorMsg.value = '请先粘贴 Markdown 文本';
    return;
  }
  pastePreview.value = text.slice(0, 800) + (text.length > 800 ? '\n…' : '');
}
async function onPasteOpen() {
  const text = pasteText.value.trim();
  if (!text) {
    errorMsg.value = '请先粘贴 Markdown 文本';
    return;
  }
  try {
    // T3: 先持久化保存 (pastes.json)
    const item = await savePaste('', text);
    await refreshPastes();
    // 写临时文件并进入阅读
    const { invoke } = await import('@tauri-apps/api/core');
    const tmpPath = await invoke<string>('open_clipboard_doc', { text });
    emit('open', tmpPath);
    showPaste.value = false;
    pasteText.value = '';
  } catch (e) {
    errorMsg.value = `打开失败：${String(e)}`;
  }
}

async function refreshPastes() {
  try {
    pastes.value = (await listPastes()).sort((a, b) => b.ts - a.ts);
  } catch { /* noop */ }
}

async function reopenPaste(item: PasteItem) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const tmpPath = await invoke<string>('open_clipboard_doc', { text: item.text });
    emit('open', tmpPath);
  } catch (e) {
    errorMsg.value = `打开失败：${String(e)}`;
  }
}

async function removePaste(id: string) {
  try {
    await deletePaste(id);
    await refreshPastes();
  } catch (e) {
    errorMsg.value = `删除失败：${String(e)}`;
  }
}

// P2: 删除单条浏览记录 + 清空全部
async function doRemoveHistoryEntry(entry: HistoryEntry) {
  try {
    await removeHistoryEntry(entry.path, entry.ts);
    history.value = history.value.filter((h) => !(h.path === entry.path && h.ts === entry.ts));
  } catch (e) {
    errorMsg.value = `删除失败：${String(e)}`;
  }
}

async function clearAllHistory() {
  try {
    await clearHistory();
    history.value = [];
  } catch (e) {
    errorMsg.value = `清空失败：${String(e)}`;
  }
}

function openInboxItem(item: InboxItem) {
  emit('open', item.path);
  showInbox.value = false;
}

function openLastBook() {
  if (lastBook.value) emit('open', lastBook.value.path);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtFullTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${fmtTime(ts)} ${hh}:${mm}`;
}

function openHistory(h: HistoryEntry) {
  emit('open', h.path);
}

function historyName(path: string): string {
  return path.split(/[\\/]/).pop()?.replace(/\.(md|markdown|txt|docx?|pdf)$/i, '') ?? path;
}

// T3: 从路径取文件夹名
function folderNameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function historyIcon(kind: 'open' | 'highlight' | 'close'): string {
  return kind === 'highlight' ? 'i-lucide-highlighter text-pd-acc' :
         kind === 'close' ? 'i-lucide-x text-pd-dim' :
         'i-lucide-book-open text-pd-dim';
}

function historyKindLabel(kind: 'open' | 'highlight' | 'close'): string {
  return kind === 'highlight' ? '划线' : kind === 'close' ? '关闭' : '打开';
}

const themeIcon = computed(() =>
  currentTheme.value === 'light' ? 'i-lucide-sun' :
  currentTheme.value === 'sepia' ? 'i-lucide-book-open' :
  'i-lucide-moon',
);
const themeLabel = computed(() =>
  currentTheme.value === 'light' ? '浅色' :
  currentTheme.value === 'sepia' ? '护眼' :
  '深色',
);
</script>

<template>
  <div class="flex-1 flex flex-col p-8 overflow-y-auto">
    <header class="flex items-center justify-between mb-8">
      <h1 class="text-2xl font-bold">陪读</h1>
      <div class="flex gap-2">
        <button class="pd-icon" @click="cycleTheme" :title="`主题：${currentTheme}`">
          <span :class="themeIcon" />
        </button>
        <button class="pd-icon" @click="showHelp = true" title="帮助">
          <span class="i-lucide-help-circle" />
        </button>
      </div>
    </header>

    <section class="mb-6 flex gap-3 flex-wrap">
      <button class="btn-primary" @click="onPickFile">
        <span class="i-lucide-book-open" /> 打开文档
      </button>
      <button class="btn-primary" @click="triggerFolderPicker">
        <span class="i-lucide-folder-open" /> 浏览文件夹
      </button>
      <button
        v-if="hasLastBook"
        class="btn"
        :title="`继续上次：${lastBookTitle}`"
        @click="openLastBook"
      >
        <span class="i-lucide-history" /> 继续：《{{ lastBookTitle }}》
      </button>
      <!-- P2: 粘贴预览 -->
      <button class="btn" @click="showPaste = true" title="粘贴 Markdown 文本预览">
        <span class="i-lucide-clipboard-paste" /> 粘贴预览
      </button>
      <!-- T6: 笔记库 — 跨文档查看所有划线/想法 -->
      <button class="btn" @click="showNotesLib = true" title="所有划线 / 想法">
        <span class="i-lucide-library" /> 笔记库
      </button>
      <button
        v-if="inboxPath"
        class="btn"
        :title="`收件箱：${inboxPath}`"
        @click="openInbox"
      >
        <span class="i-lucide-inbox" /> 收件箱
      </button>
    </section>

    <!-- T3: 最近文件夹卡片(横滑) -->
    <section v-if="lastFolderPaths.length" class="mt-4">
      <h2 class="text-lg mb-3 text-pd-dim">
        <span class="i-lucide-folder-open" /> 最近浏览的文件夹
      </h2>
      <div class="flex gap-2 overflow-x-auto pb-2">
        <div
          v-for="p in lastFolderPaths"
          :key="p"
          class="group flex-shrink-0 border border-pd-border rounded p-2 min-w-[200px] max-w-[260px] cursor-pointer hover:bg-pd-border/30"
          @click="switchToFolder(p)"
        >
          <div class="flex items-center gap-2">
            <span class="i-lucide-folder text-pd-acc" />
            <span class="flex-1 text-sm font-medium truncate" :title="p">
              {{ folderNameOf(p) }}
            </span>
            <button
              class="pd-icon opacity-0 group-hover:opacity-100"
              title="从最近列表移除"
              @click.stop="removeRecentFolder(p)"
            >
              <span class="i-lucide-x" />
            </button>
          </div>
          <div class="text-xs text-pd-dim truncate mt-1" :title="p">{{ p }}</div>
        </div>
      </div>
    </section>

    <section v-if="hasShelf" class="mt-4">
      <h2 class="text-lg mb-3 text-pd-dim">最近阅读</h2>
      <ul class="space-y-1">
        <li
          v-for="item in shelf"
          :key="item.path"
          class="toc-item group"
          @click="openItem(item)"
        >
          <span class="i-lucide-bookmark text-pd-acc" />
          <span class="flex-1 truncate">{{ item.title || item.path }}</span>
          <span class="text-xs text-pd-dim">
            {{ Math.min(item.maxAnchor + 1, item.totalSegs) }} / {{ item.totalSegs }} 段
            · {{ fmtTime(item.lastOpen) }}
          </span>
          <span class="text-xs text-pd-dim ml-2" v-if="item.totalSegs > 0">
            {{ Math.round((Math.min(item.maxAnchor + 1, item.totalSegs) / item.totalSegs) * 100) }}%
          </span>
          <!-- T5: 预览 / 复制 -->
          <button
            class="pd-icon opacity-0 group-hover:opacity-100"
            title="预览"
            @click.stop="showPreview(item)"
          >
            <span class="i-lucide-eye" />
          </button>
          <button
            class="pd-icon opacity-0 group-hover:opacity-100"
            title="复制前 200 字"
            @click.stop="copyPreviewOf(item)"
          >
            <span class="i-lucide-copy" />
          </button>
          <button
            class="pd-icon opacity-0 group-hover:opacity-100"
            title="从书架移除"
            @click.stop="removeItem(item)"
          >
            <span class="i-lucide-x" />
          </button>
        </li>
      </ul>
    </section>

    <!-- P3: Tab 标签 — 浏览文件夹 / 浏览记录 / 粘贴 / 书签 -->
    <nav v-if="hasAnyList" class="mt-4 border-b border-pd-border flex gap-0">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="px-4 py-2 text-[14px] transition-colors"
        :class="activeTab === t.id
          ? 'border-b-2 border-pd-acc text-pd-fg font-medium'
          : 'text-pd-dim hover:text-pd-fg'"
        @click="activeTab = t.id"
      >
        <span :class="t.icon" /> {{ t.label }}
        <span v-if="t.count > 0" class="ml-1 text-xs">({{ t.count }})</span>
      </button>
    </nav>

    <!-- P2+P3: Tab 内容 — 每个列表独立 max-h + 独立滚动 -->
    <section v-if="hasAnyList" class="mt-3">
      <!-- 浏览文件夹 -->
      <div v-if="activeTab === 'folder' && folderTree">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium text-pd-dim">
            <span class="i-lucide-folder-open" /> {{ folderTree.name }}
          </h3>
          <button class="pd-icon" @click="folderTree = null" title="关闭树">
            <span class="i-lucide-x" />
          </button>
        </div>
        <!-- P2: 独立 max-h + 滚动, 不让几千节点撑爆视口 -->
        <div class="border border-pd-border rounded max-h-[60vh] overflow-y-auto p-2">
          <FolderTree :node="folderTree" @open="emit('open', $event)" />
        </div>
      </div>

      <!-- 浏览记录 -->
      <div v-else-if="activeTab === 'history'">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium text-pd-dim">
            <span class="i-lucide-history" /> 浏览记录
          </h3>
          <button
            v-if="history.length"
            class="btn-soft text-[12px]"
            @click="clearAllHistory"
            title="清空"
          >
            清空
          </button>
        </div>
        <div v-if="history.length" class="border border-pd-border rounded max-h-[60vh] overflow-y-auto p-2">
          <ul class="space-y-1">
            <li
              v-for="h in history"
              :key="`${h.path}:${h.ts}`"
              class="toc-item group"
              @click="openHistory(h)"
            >
              <span :class="historyIcon(h.kind)" />
              <span class="flex-1 truncate">{{ historyName(h.path) }}</span>
              <span class="text-xs text-pd-dim">{{ fmtFullTime(h.ts) }} · {{ historyKindLabel(h.kind) }}</span>
              <!-- P2: 删除单行按钮 -->
              <button
                class="pd-icon opacity-0 group-hover:opacity-100"
                title="删除此条"
                @click.stop="doRemoveHistoryEntry(h)"
              >
                <span class="i-lucide-x" />
              </button>
            </li>
          </ul>
        </div>
        <p v-else class="text-sm text-pd-dim px-3 py-4">暂无浏览记录</p>
      </div>

      <!-- 粘贴记录 -->
      <div v-else-if="activeTab === 'paste'">
        <h3 class="text-sm font-medium text-pd-dim mb-2">
          <span class="i-lucide-clipboard-paste" /> 粘贴记录
        </h3>
        <div v-if="pastes.length" class="border border-pd-border rounded max-h-[60vh] overflow-y-auto p-2">
          <ul class="space-y-1">
            <li
              v-for="p in pastes"
              :key="p.id"
              class="toc-item group"
              @click="reopenPaste(p)"
            >
              <span class="i-lucide-clipboard-paste text-pd-acc" />
              <span class="flex-1 truncate">{{ p.title }}</span>
              <span class="text-xs text-pd-dim">{{ fmtFullTime(p.ts) }} · {{ p.text.length }} 字</span>
              <button
                class="pd-icon opacity-0 group-hover:opacity-100"
                title="删除"
                @click.stop="removePaste(p.id)"
              >
                <span class="i-lucide-x" />
              </button>
            </li>
          </ul>
        </div>
        <p v-else class="text-sm text-pd-dim px-3 py-4">暂无粘贴记录</p>
      </div>

      <!-- 书签 -->
      <div v-else-if="activeTab === 'bookmark'">
        <h3 class="text-sm font-medium text-pd-dim mb-2">
          <span class="i-lucide-bookmark" /> 书签
        </h3>
        <div v-if="bookmarks.length" class="border border-pd-border rounded max-h-[60vh] overflow-y-auto p-2">
          <ul class="space-y-1">
            <li
              v-for="b in bookmarks"
              :key="b.id"
              class="toc-item group"
              @click="emit('open', b.path)"
            >
              <span class="i-lucide-bookmark text-pd-acc" />
              <span class="flex-1 truncate">{{ b.title }}</span>
              <span class="text-xs text-pd-dim">{{ fmtFullTime(b.ts) }} · 段 #{{ b.seg_index + 1 }}</span>
              <button
                class="pd-icon opacity-0 group-hover:opacity-100"
                title="删除书签"
                @click.stop="removeBookmark(b.id)"
              >
                <span class="i-lucide-x" />
              </button>
            </li>
          </ul>
        </div>
        <p v-else class="text-sm text-pd-dim px-3 py-4">暂无书签</p>
      </div>
    </section>

    <section
      v-if="!hasShelf && !history.length && !folderTree"
      class="mt-8 rounded-lg border border-dashed border-pd-border p-6 text-center text-pd-dim"
    >
      <p class="text-base mb-2">还没有阅读历史</p>
      <p class="text-sm">
        把 <code>.md</code> / <code>.markdown</code> / <code>.txt</code>
        文件<strong class="text-pd-fg">拖入此窗口</strong>，或点上方「打开文档」/「浏览文件夹」。
      </p>
    </section>

    <p v-if="errorMsg" class="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ errorMsg }}
    </p>

    <HelpModal v-if="showHelp" @close="showHelp = false" />

    <!-- T5: 预览 modal -->
    <div v-if="previewText !== null" class="modal-backdrop" @click.self="previewText = null">
      <div class="modal-card max-h-[70vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-bold">
            <span class="i-lucide-eye text-pd-dim mr-2" />
            {{ previewPath?.split(/[\\/]/).pop() }}
          </h3>
          <button class="pd-icon" @click="previewText = null"><span class="i-lucide-x" /></button>
        </div>
        <pre class="whitespace-pre-wrap text-sm leading-relaxed font-serif text-pd-fg">{{ previewText }}</pre>
        <div class="mt-4 flex gap-2 justify-end">
          <button class="btn-primary" @click="previewPath && copyPreviewOf({ path: previewPath } as ShelfItem); previewText = null">
            <span class="i-lucide-copy" /> 复制全文
          </button>
        </div>
      </div>
    </div>

    <!-- P2: 粘贴预览 modal -->
    <div v-if="showPaste" class="modal-backdrop" @click.self="showPaste = false">
      <div class="modal-card max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-bold">
            <span class="i-lucide-clipboard-paste text-pd-acc mr-2" />
            粘贴预览
          </h3>
          <button class="pd-icon" @click="showPaste = false"><span class="i-lucide-x" /></button>
        </div>
        <textarea
          v-model="pasteText"
          placeholder="把 Markdown 文本粘贴到这里，点击下方「预览」查看渲染效果。满意后点「开始阅读这段」。"
          class="w-full min-h-[160px] bg-pd-bg border border-pd-border rounded p-3 text-[14px] font-mono text-pd-fg resize-y"
        />
        <div class="mt-3 flex gap-2 justify-end">
          <button class="btn" @click="onPastePreview">
            <span class="i-lucide-eye" /> 预览
          </button>
          <button class="btn-primary" @click="onPasteOpen" :disabled="!pasteText.trim()">
            <span class="i-lucide-book-open" /> 开始阅读这段
          </button>
        </div>
        <div v-if="pastePreview" class="mt-4">
          <h4 class="text-sm font-bold text-pd-dim mb-2">预览（前 800 字符）</h4>
          <pre class="whitespace-pre-wrap text-[14px] leading-relaxed font-serif text-pd-fg bg-pd-border/10 p-3 rounded">{{ pastePreview }}</pre>
        </div>
      </div>
    </div>

    <!-- T6: 笔记库 — 跨文档所有划线/想法 -->
    <div v-if="showNotesLib" class="modal-backdrop" @click.self="showNotesLib = false">
      <div class="modal-card max-h-[80vh] w-[min(96vw,900px)] flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-lg font-bold">
            <span class="i-lucide-library text-pd-acc mr-2" />笔记库（{{ notesLib.length }}）
          </h3>
          <button class="btn" @click="showNotesLib = false"><span class="i-lucide-x" /></button>
        </div>
        <div v-if="notesLib.length === 0" class="text-sm text-pd-dim py-8 text-center">
          还没有划线/想法。在阅读时选中文字按 <kbd>h</kbd> 划线，按 <kbd>Shift+H</kbd> 添加想法。
        </div>
        <ul v-else class="space-y-2 overflow-y-auto pr-1">
          <li
            v-for="(n, i) in notesLib"
            :key="i"
            class="border border-pd-border rounded p-3 cursor-pointer hover:bg-pd-border/30"
            @click="emit('open', n.path); showNotesLib = false"
          >
            <div class="text-xs text-pd-dim mb-1 truncate">{{ n.path }} · {{ fmtFullTime(n.ts) }}</div>
            <div class="text-sm">"<span class="text-pd-fg">{{ n.text }}</span>"</div>
            <div v-if="n.note" class="text-xs italic text-pd-acc mt-1">💭 {{ n.note }}</div>
          </li>
        </ul>
      </div>
    </div>

    <!-- 收件箱抽屉 -->
    <div v-if="showInbox" class="modal-backdrop" @click.self="showInbox = false">
      <div class="modal-card max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">收件箱（{{ inboxItems.length }}）</h3>
          <button class="btn" @click="showInbox = false"><span class="i-lucide-x" /></button>
        </div>
        <p class="text-xs text-pd-dim mb-3">扫描：{{ inboxPath }}</p>
        <div v-if="inboxItems.length === 0" class="text-pd-dim text-sm">
          没有新文件。
        </div>
        <ul v-else class="space-y-1">
          <li
            v-for="item in inboxItems"
            :key="item.path"
            class="toc-item"
            @click="openInboxItem(item)"
          >
            <span class="i-lucide-book-open text-pd-acc" />
            <span class="flex-1 truncate">{{ item.name }}</span>
            <span class="text-xs text-pd-dim">{{ fmtTime(item.mtime) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
