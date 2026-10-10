#!/usr/bin/env pwsh
# build-fast.ps1 — 「陪读」快速构建（产出与 pnpm tauri build --no-bundle 等价，但更快）
#
# 用法:  pwsh -File scripts\build-fast.ps1 [-ForceFrontend]
#
# 做三件事:
#   1) 构建前结束运行中的 peidu.exe —— 否则 cargo 删旧 exe 会 os error 5 失败（白等一整轮编译）
#   2) 前端源码内容未变 → 跳过 vite —— dist 不被重写, Rust 侧保持 Fresh, 秒级完成
#   3) 直连 cargo（与 tauri CLI 相同 flags）, 作为统一构建入口, 避免 CLI/直连 env 翻转触发额外重编
#
# 何时仍用 pnpm tauri build --no-bundle:
#   - 改动了 tauri 能力/权限（gen/schemas）等需要 tauri CLI 完整流程的场景
#   - 需要真实打包（msi/nsis）时（那时不要 --no-bundle）

[CmdletBinding()]
param(
    [switch]$ForceFrontend  # 强制重新构建前端（默认按内容指纹跳过未变化的前端）
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $root 'src-tauri'
$stateDir = Join-Path $root '.app-data'
$hashFile = Join-Path $stateDir 'frontend.hash'

# --- 1) 守门: 结束运行中的 peidu.exe ---
function Stop-Peidu {
    $null = taskkill /F /IM peidu.exe 2>&1
    return ($LASTEXITCODE -eq 0)
}
if (Stop-Peidu) {
    Write-Host "[guard] 已结束运行中的 peidu.exe" -ForegroundColor Yellow
}

# --- 2) 前端内容指纹（内容 hash, 与 mtime 无关）---
$frontInputs = @(
    (Join-Path $root 'src'),
    (Join-Path $root 'index.html'),
    (Join-Path $root 'vite.config.ts'),
    (Join-Path $root 'uno.config.ts'),
    (Join-Path $root 'package.json'),
    (Join-Path $root 'tsconfig.json')
) | Where-Object { Test-Path $_ }

$sha = [System.Security.Cryptography.SHA256]::Create()
$sb = [System.Text.StringBuilder]::new()
foreach ($f in (Get-ChildItem -Path $frontInputs -Recurse -File | Sort-Object FullName)) {
    $rel = $f.FullName.Substring($root.Length)
    $fileHash = [Convert]::ToHexString($sha.ComputeHash([System.IO.File]::ReadAllBytes($f.FullName)))
    [void]$sb.Append($rel).Append('=').Append($fileHash).Append(';')
}
$current = [Convert]::ToHexString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString())))

$prev = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
$frontChanged = $ForceFrontend -or ($current -ne $prev)

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($frontChanged) {
    Write-Host "[1/2] 前端有变化 → pnpm build (vue-tsc + vite)" -ForegroundColor Cyan
    Push-Location $root
    try {
        pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败 (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
} else {
    Write-Host "[1/2] 前端未变化 → 跳过 vite（dist 保持不动）" -ForegroundColor DarkGray
}
$tFront = $sw.Elapsed.TotalSeconds

# --- 3) cargo（与 tauri CLI 相同 flags）---
Write-Host "[2/2] cargo build --bins --features tauri/custom-protocol --release" -ForegroundColor Cyan
Push-Location $srcTauri
try {
    $attempt = 0
    while ($true) {
        $attempt++
        $cargoLog = $null
        cargo build --bins --features tauri/custom-protocol --release 2>&1 | Tee-Object -Variable cargoLog
        if ($LASTEXITCODE -eq 0) { break }
        # 链接阶段 exe 被占用（构建期间应用又被启动）: 关闭后重试, 最多 2 次
        $text = $cargoLog | Out-String
        if ($attempt -le 2 -and $text -match 'failed to remove' -and $text -match 'os error 5') {
            Write-Host "[retry] peidu.exe 被占用, 关闭后重试 ($attempt/2)..." -ForegroundColor Yellow
            $null = Stop-Peidu
            Start-Sleep -Seconds 1
            continue
        }
        throw "cargo build 失败 (exit $LASTEXITCODE)"
    }
} finally { Pop-Location }
$sw.Stop()

# 构建成功才更新指纹
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Set-Content -Path $hashFile -Value $current -NoNewline

$exe = Join-Path $srcTauri 'target\x86_64-pc-windows-msvc\release\peidu.exe'
$size = [Math]::Round((Get-Item $exe).Length / 1MB, 1)
$tCargo = $sw.Elapsed.TotalSeconds - $tFront
Write-Host ""
Write-Host ("构建完成: {0}  ({1} MB)" -f $exe, $size) -ForegroundColor Green
Write-Host ("前端 {0:N1}s | cargo {1:N1}s | 总计 {2:N1}s" -f $tFront, $tCargo, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
