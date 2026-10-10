# 图标占位

Tauri 2 必需图标文件，否则 build 失败。

## 占位方案

在 D0 阶段不创建正式图标。**临时方案**：

```bash
# 从其他 Tauri 项目复制默认图标
# 或从 https://tauri.app/v1/api/config/#icon 找一个
```

需要的文件：

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns`（macOS，可选）
- `icon.ico`（Windows）

## 推荐做法

1. 用 https://www.appicon.co/ 生成多尺寸
2. 或 `cargo tauri icon path/to/source.png` 一键生成

`tauri.conf.json` 的 `bundle.icon` 已配置好上述文件名，**只要文件存在即可**。
