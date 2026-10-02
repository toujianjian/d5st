<#
  数据库迁移脚本（导出 / 导入 d5st + casdoor 两个库）
  用法：
    pwsh docker/db-migrate.ps1 export [输出文件]
    pwsh docker/db-migrate.ps1 import <备份文件>

  说明：
    - 在项目根目录（docker-compose.yml 所在目录）执行。
    - 必须同时导出 d5st 与 casdoor 两个库：
        d5st    = 站点数据（用户映射、帖子、好友、积分…）
        casdoor = 认证数据（Casdoor 用户/组织/应用/Provider…）
      只导 d5st 会出现"本地有用户、Casdoor 没有"的不一致。
    - 导入会用备份覆盖目标环境这两个库的同名表，导入前请自行备份目标库。
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('export', 'import')][string]$Action,
  [string]$File
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# 读取 MySQL root 密码：.env 优先，否则用 compose 默认值
$rootPwd = 'd5st_root_2026'
if (Test-Path .env) {
  $m = Select-String -Path .env -Pattern '^MYSQL_ROOT_PASSWORD=' | Select-Object -First 1
  if ($m) { $rootPwd = ($m.Line -split '=', 2)[1].Trim() }
}

if ($Action -eq 'export') {
  if (-not $File) { $File = "backup/d5st-backup-$(Get-Date -Format yyyyMMdd-HHmmss).sql" }
  New-Item -ItemType Directory -Force -Path (Split-Path $File) | Out-Null
  Write-Host "[export] d5st + casdoor -> $File"
  # 用 cmd 重定向，保证写出的是 mysqldump 的原始 UTF-8 字节（PowerShell 管道会改编码）
  cmd /c "docker compose exec -T mysql mysqldump -uroot -p$rootPwd --databases d5st casdoor --single-transaction --routines --triggers --default-character-set=utf8mb4 > `"$File`""
  Write-Host "[export] 完成：$File"
}
else {
  if (-not $File) { throw 'import 需要指定备份文件，例如: pwsh docker/db-migrate.ps1 import backup/xxx.sql' }
  if (-not (Test-Path $File)) { throw "备份文件不存在: $File" }
  Write-Host "[import] 从 $File 导入（将覆盖 d5st / casdoor 同名表）..."
  cmd /c "docker compose exec -T mysql mysql -uroot -p$rootPwd < `"$File`""
  Write-Host "[import] 完成，建议重启应用： docker compose restart app"
}
