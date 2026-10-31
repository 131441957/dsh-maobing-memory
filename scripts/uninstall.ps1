# 从指定 profile 卸载 maobing-memory：删符号链接 + 摘掉 patch 里那一块。
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DshHome <DSH_HOME 路径> -Profile web
# 也可先设置环境变量 DSH_HOME，再省略 -DshHome。
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

$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\maobing-memory'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path $target) {
  $item = Get-Item $target -Force
  if ($item.LinkType -eq 'SymbolicLink') { & cmd /c rmdir "$target"; Write-Host "[1/2] 已删除链接：$target" }
  else { throw "目标不是符号链接，拒绝删除（可能是真实安装）：$target" }
} else {
  Write-Host "[1/2] 链接不存在，跳过"
}

# 收掉 install.ps1 自己建的空 node_modules（只在**确认为空**时删，不碰别人的东西）
$nm = Join-Path $profileDir 'node_modules'
if (Test-Path $nm) {
  $left = @(Get-ChildItem $nm -Force)
  if ($left.Count -eq 0) { Remove-Item $nm -Force; Write-Host "[1/2] 顺手收掉空目录：$nm" }
}

if (Test-Path $patchFile) {
  $raw = Get-Content $patchFile -Raw -Encoding utf8
  if ($raw -match 'maobing-memory') {
    # 整块匹配：注释行 + insert 三行。
    # 名字用「可选的 dsh- 前缀」兼容两种写法：2026-10-31 插件改名时这里漏改（正则还是旧名），
    # 结果卸载报「自动摘除失败」并残留 patch 块 —— 冒烟里已加断言，改名漏改会变红。
    $pattern = '(?s)(\r?\n)?# maobing-memory（由 scripts\\install\.ps1 写入；卸载用 uninstall\.ps1）\r?\n- insert:\r?\n\s+- id: (?:dsh-)?maobing-memory\r?\n\s+name: ''(?:dsh-)?maobing-memory''\r?\n?'
    $stripped = [regex]::Replace($raw, $pattern, '')
    if ($stripped -match 'maobing-memory') { throw "自动摘除失败，请手工编辑 $patchFile" }
    $leftover = (($stripped -split "`r?`n") | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }) -join "`n"
    if ($leftover.Trim() -eq '') { $stripped = $stripped.TrimEnd() + "`r`n[]`r`n" }
    Set-Content -Path $patchFile -Value $stripped -Encoding utf8
    Write-Host "[2/2] 已从 patch 摘除：$patchFile"
  } else {
    Write-Host "[2/2] patch 里没有本插件，跳过"
  }
} else {
  Write-Host "[2/2] patch 文件不存在，跳过"
}

Write-Host ''
Write-Host "卸载完。重启该 profile 实例后，图标与面板应消失、工具应不可见。"
Write-Host "记忆库文件保留在 <DSH_HOME>\storages\maobing-memory\memory.db（要清就跑的时候手删）"
