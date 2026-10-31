# 把 maobing-memory 装进指定 DSH profile（默认 web）。
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DshHome <DSH_HOME 路径> -Profile web
# 也可先设置环境变量 DSH_HOME，再省略 -DshHome。
# 原理：profile/node_modules 里放一个指向本仓库的符号链接，并在 profile 的
# cordis.patch.yml 里登记一行 insert。卸载见 uninstall.ps1。
param(
  [string]$Profile = 'web',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) {
  throw '需要 DSH 数据目录：请用 -DshHome <路径> 指定，或先设置环境变量 DSH_HOME。'
}
if (-not (Test-Path $DshHome)) { throw "DSH_HOME 不存在：$DshHome" }

$pluginRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\maobing-memory'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir" }
if (-not (Test-Path (Join-Path $pluginRoot 'lib\index.js'))) { throw "产物缺失，先跑 npm run build：$pluginRoot\lib\index.js" }

New-Item -ItemType Directory -Path (Join-Path $profileDir 'node_modules') -Force | Out-Null

if (Test-Path $target) {
  $existing = Get-Item $target -Force
  if ($existing.LinkType -eq 'SymbolicLink') { & cmd /c rmdir "$target" }
  else { throw "目标已存在且不是符号链接，请先确认：$target" }
}
New-Item -ItemType SymbolicLink -Path $target -Target $pluginRoot | Out-Null
Write-Host "[1/2] 已链接：$target -> $pluginRoot"

$block = @"
# maobing-memory（由 scripts\install.ps1 写入；卸载用 uninstall.ps1）
- insert:
    - id: dsh-maobing-memory
      name: 'dsh-maobing-memory'
"@

$current = if (Test-Path $patchFile) { (Get-Content $patchFile -Raw -Encoding utf8) } else { '' }
$meaningful = (($current -split "`r?`n") | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }) -join "`n"
if ($current -match 'maobing-memory') {
  Write-Host "[2/2] patch 已登记，跳过"
} elseif ($meaningful.Trim() -eq '' -or $meaningful.Trim() -eq '[]') {
  # 只含注释与空数组：把 [] 那一行换成 insert 块
  $new = if ($meaningful.Trim() -eq '[]') {
    [regex]::Replace($current, '(?m)^\[\]\s*$', $block.TrimEnd())
  } else {
    $block
  }
  Set-Content -Path $patchFile -Value $new -Encoding utf8
  Write-Host "[2/2] 已写入 patch：$patchFile"
} else {
  throw "patch 文件非空且未登记本插件，请手工在 $patchFile 追加：`n$block"
}

Write-Host ''
Write-Host "装好了（profile: $Profile）。重启该 profile 的 DSH 实例后验证："
Write-Host "  - 左侧栏出现「小毛病」入口，点开是整页面板（五个 tab）"
Write-Host "  - 工具列表出现 12 个 memory_* 工具（remember/search/read/update/recent/project/find_similar/dream + 笔记 4 个）"
Write-Host "  - 插件日志里有「启动：版本 …」与「就绪：工具 12 个 …」两行"
Write-Host "    （日志路径：<DSH_HOME>\storages\maobing-memory\maobing-memory.log）"
