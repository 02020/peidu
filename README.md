# 陪读桌面版（peidu）

> 单人本地使用的 Windows 10/11 Markdown 阅读器。
> 设计文档：`../reader-桌面版设计.md`（本目录下不再重复设计规约）

## 环境要求

- Node.js ≥ 18
- pnpm ≥ 8
- Rust toolchain (stable)
- Windows 10/11 (x64 / arm64)

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式（热重载）
pnpm tauri dev

# 3. 生产构建
pnpm tauri build
```

## 项目结构

```
peidu/
├── src/
│   ├── core/         # 纯 TS 算法层，零框架/零 Tauri 依赖
│   ├── platform/     # Tauri 桥接层
│   ├── ui/           # Vue 3 视图层
│   └── styles/       # CSS tokens
├── src-tauri/        # Rust 后端
├── public/           # 静态资源
├── tests/            # core/ 单测
└── (配置文件)        # package.json / vite.config.ts / uno.config.ts 等
```

## 当前阶段

**D0 + D1 合并**——地基（脚手架 + core 移植 + 编码 + 拖放 + .big + 窗口状态）
+ 记忆（锚点 + 书架 + Esc 新规 + 帮助面板）。

具体进度见设计文档 §10.1。





```bash
pnpm tauri build --no-bundle
```