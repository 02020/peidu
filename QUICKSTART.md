# 快速开始

> 本文档列出手动执行的命令。
> 我（agent）已写完所有源码；你负责装环境 + 跑命令 + 反馈报错。

## 一次性操作

```powershell
# 1. 进入项目
cd D:\architect\20_tech\reading\peidu

# 2. 初始化 git
git init
git add .
git commit -m "init: peidu D0+D1 骨架"

# 3. 安装前端依赖
pnpm install

# 4. 切换 Rust 工具链为 stable-gnu（项目级 override，仅本目录生效）
cd src-tauri
rustup override set stable-x86_64-pc-windows-gnu
cd ..

# 5. 启动 Tauri 开发模式（首次会编译 Rust 依赖，3-10 分钟）
pnpm tauri dev
```

> **为什么用 stable-gnu？** 本项目 Rust 侧全部是 pure Rust crate（encoding_rs / chardetng / notify / rusqlite bundled / parking_lot / once_cell），不需要 MSVC `cl.exe` / `link.exe` / Windows SDK。stable-gnu 自带 LLVM 工具链（含 `lld-link`），可以链接 PE/COFF。
> 之所以从 Cargo.toml 中**移除了 `tauri-plugin-single-instance`**，是因为它在 0.x 历史版本里通过 `windows-sys` 传递依赖拉了 `vswhom-sys`，vswhom-sys 的 build.rs 强制调 `cl.exe`。T5 单实例留到 D2+ 用其他方式实现。


## 验证清单

启动成功后，在 Tauri 窗口里：

- [ ] 看到「陪读」标题 + 浅黄色 sepia 背景
- [ ] 点击「打开文档」按钮，弹出系统文件选择对话框
- [ ] 选一个 .md 文件，能正常阅读
- [ ] 按 `Space` / `→` 翻到下一段
- [ ] 按 `←` 翻回上一段
- [ ] 按 `t` 打开目录
- [ ] 按 `?` 打开帮助
- [ ] 按 `Esc` 关闭模态

## 跑单测

```bash
pnpm test
```

应看到 6 个 describe 块全部通过。

## 可能的问题

### 1. 编译错误（Rust 侧）

第一次 `pnpm tauri dev` 会下载并编译很多 crate，可能 5-15 分钟。如果失败：

```bash
cd src-tauri
cargo build 2>&1 | tee build.log
```

把最后 50 行报错贴回来。

### 2. 模块找不到（TS 侧）

`@core/*` / `@platform/*` 是 tsconfig + vite 别名。如果 Vite 报模块解析失败：

```bash
# 检查 vite.config.ts 中 alias 配置
# 检查 tsconfig.json 中 paths 配置
```

### 3. 能力权限（Tauri 侧）

如果遇到"permission denied"或"not allowed"：

- 检查 `src-tauri/capabilities/default.json` 是否包含对应权限
- 临时加权限：`"core:webview:allow-internal-toggle-devtools"`（仅开发模式）

### 4. Tauri 2 plugin 找不到

如 `tauri-plugin-fs` 未在 Cargo.toml 中但 `use` 了：

```bash
cd src-tauri
cargo add tauri-plugin-fs
```

## 文件清单

```
peidu/
├── README.md                    # 项目说明
├── QUICKSTART.md                # 本文件
├── .gitignore
├── package.json                 # Node 依赖
├── tsconfig.json                # TS 别名 + 配置
├── vite.config.ts               # Vite + UnoCSS + Vitest
├── uno.config.ts                # UnoCSS 主题 + 快捷类
├── index.html                   # HTML 入口
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── styles/tokens.css
│   ├── core/                    # 6 个纯函数模块
│   │   ├── segmenter.ts
│   │   ├── fitSeg.ts
│   │   ├── anchor.ts
│   │   ├── highlight.ts
│   │   ├── textwrap.ts
│   │   ├── frontmatter.ts
│   │   └── index.ts
│   ├── platform/                # 4 个 Tauri 桥接模块
│   │   ├── fs.ts
│   │   ├── store.ts
│   │   ├── watch.ts
│   │   ├── window.ts
│   │   └── shell.ts
│   └── ui/                      # 7 个 Vue 组件
│       ├── EntryScreen.vue      # 入口
│       ├── ReaderView.vue       # 阅读
│       ├── HelpModal.vue
│       ├── TocPanel.vue         # D2 占位
│       ├── NotesPanel.vue       # D2 占位
│       ├── Palette.vue          # D4 占位
│       └── DoneCard.vue         # D2 占位
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── store.rs
│       └── commands/
│           ├── mod.rs
│           ├── doc.rs
│           ├── shell.rs
│           ├── store.rs
│           └── watch.rs
└── tests/
    └── segmenter.test.ts        # 6 套单测
```

## 下一步（D2 / D3 / D4）

D0+D1 跑通后，按设计文档 §10.1 推进：

- **D2**：划线 / 速记板 / 高亮 / T4 收件箱（手动版）/ 主题三态
- **D3**：T1 watch 实时同步 / T2 相对链接 / T3 入口四件套
- **D4**：T5 全局快捷键 / T6 命令面板 / T7 FTS5 / T8 托盘 / T9 备份 / T10 双产物 / T12 便携版
