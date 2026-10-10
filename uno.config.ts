import { defineConfig, presetWind3, presetIcons } from 'unocss';

export default defineConfig({
  presets: [
    presetWind3(),
    presetIcons({
      scale: 1.2,
      warn: true,
    }),
  ],
  theme: {
    colors: {
      pd: {
        fg: 'var(--fg)',
        bg: 'var(--bg)',
        acc: 'var(--acc)',
        dim: 'var(--dim)',
        hl: 'var(--hl)',
        border: 'var(--border)',
      },
    },
  },
  shortcuts: {
    // B6: 全部用 px (不依赖 rem), 间距固定不缩放
    // T1: toc-item — 14px 文字, 12px 内边距
    'toc-item': 'flex items-center gap-[6px] px-[12px] py-[4px] rounded cursor-pointer text-[14px]',
    'modal-backdrop': 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm',
    'modal-card': 'bg-pd-bg border border-pd-border rounded-lg shadow-2xl p-6 max-w-2xl w-[90%]',
    // B6: 按钮 14px 文字, 固定间距 (px 写死, 不跟 rem 走)
    'btn': 'inline-flex items-center gap-[4px] px-[12px] py-[6px] rounded text-[14px] transition-all duration-150',
    'btn-soft': 'inline-flex items-center gap-[4px] px-[12px] py-[6px] rounded text-[14px] hover:bg-pd-border/30 transition-all duration-150',
    'btn-primary': 'inline-flex items-center gap-[4px] px-[12px] py-[6px] rounded text-[14px] bg-pd-acc text-white hover:opacity-90 transition-all duration-150',
    // pd-icon — 28×28 固定 px (B6.1)
    'pd-icon': 'inline-flex items-center justify-center w-[28px] h-[28px] rounded transition-all duration-150',
    'pd-icon-lg': 'inline-flex items-center justify-center w-[36px] h-[36px] rounded transition-all duration-150',
  },
  safelist: [
    'i-lucide-book-open',
    'i-lucide-bookmark',
    'i-lucide-search',
    'i-lucide-settings',
    'i-lucide-x',
    'i-lucide-chevron-left',
    'i-lucide-chevron-right',
    'i-lucide-list',
    'i-lucide-sticky-note',
    'i-lucide-help-circle',
    'i-lucide-moon',
    'i-lucide-sun',
    'i-lucide-inbox',
    'i-lucide-history',
    'i-lucide-folder-open',
    'i-lucide-eye',
    'i-lucide-copy',
    'i-lucide-highlighter',
    'i-lucide-arrow-left',
    'i-lucide-chevron-down',
    'i-lucide-chevron-right',
    'i-lucide-refresh-cw',
    'i-lucide-corner-up-left',
    'i-lucide-maximize-2',
    'i-lucide-minimize-2',
    'i-lucide-a-large-small',
    'i-lucide-type',
    'i-lucide-clipboard-paste',
    'i-lucide-eye',
    'i-lucide-bookmark',
    'i-lucide-heading',
    'i-lucide-check',
  ],
});
