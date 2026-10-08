# 本地完整数据备份与恢复

JSON 结构和 ZIP 交付包均不能代替完整数据备份。完整备份包括 SQLite、媒体、私有回执和导出记录。

## 先停止服务

在启动 `dev` 的 PowerShell 输入 `stop` 并回车，或按 `Ctrl+C`，等待“全部开发服务正常停止”；独立启动的 `start` 和 `worker` 也需各自停止。dev 通过 IPC 等待 API 打包、worker 当前步骤与 Vite 收尾，60 秒超时明确报告强停。强停可能遗留待确认任务，不算正常关闭。关闭网页不会停止服务。自定义 `STUDIO_DATA_DIR` 时，下面的 `data` 应替换为实际数据目录。

复制前确认本次项目进程退出、4310/4311（或自定义端口）释放，数据文件可读。不要结束所有 Node 进程；其他项目可能正在运行。若必须强停，先核实进程 ID、命令行和父进程归属，保留现场，重启检查任务/导出状态后再正常停止并备份。

备份需要服务停用，避免复制时数据库/WAL 与媒体写入不一致。不能运行中只复制 `studio.sqlite`；`-wal`、`-shm` 如存在必须与整目录一起处理。不要用下面的恢复操作覆盖正在运行的数据。

## 备份：保留新的完整副本

在项目根目录执行：

```powershell
$ErrorActionPreference = 'Stop'
$taskData = Join-Path (Get-Location) 'data'
$taskBackup = Join-Path (Get-Location) ('output/backups/data-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (-not (Test-Path -LiteralPath (Join-Path $taskData 'studio.sqlite'))) { throw '数据库不存在，请核实数据目录' }
if (Test-Path -LiteralPath $taskBackup) { throw '备份路径已存在，拒绝覆盖' }
New-Item -ItemType Directory -Path (Split-Path $taskBackup -Parent) -Force | Out-Null
Copy-Item -LiteralPath $taskData -Destination $taskBackup -Recurse
Write-Output $taskBackup
```

`provider-results/` 可能含私有签名链接，完整数据备份仅在受控本地位置保管，不作为公开素材交付。`.env` 不在 data 中，需要另行保管服务配置；不把真实密钥提交进 Git。

## 先做独立恢复验证

下面的脚本把备份复制到新目录，对全部文件做 SHA-256 比对、SQLite integrity_check、项目与任务读取、媒体完整性检查；拒绝覆盖现有恢复目录，不替换当前 data：

```powershell
node --import tsx scripts/m5-backup-check.ts 'output/m5-stopped-data' 'output/m5-restore-check-new'
```

把第一参数替换为实际停服务备份。输出报告位于 `output/m5/verified-backup-report.json`；若媒体有缺失，`assetsUnavailable` 非 0，不能当作完整素材恢复通过。

本轮实测有效备份为 `output/m5-stopped-data/`，独立恢复目录为 `output/m5-verified-restore/`，42 个文件校验相同、SQLite 完整性通过，7 个项目/13 个任务/21 个可用资产。该备份制作于后续浏览器导入之前，不包含之后新建项目或导出记录。早期未正确停服务的副本不作为恢复证据；以 verified-backup-report 为准。

上段是 M5 历史证据。V1.6 升级前另保留 `output/optimization/stopped-data/`（DB4，50 文件，含 WAL/SHM）和 `stopped-data-hashes.json`，旧代码 `baseline-code/`（82 文件）及 `baseline-code-hashes.json`。隔离副本事务升级通过；原 data 4→5 的逐行审计保留 8 项目/13 任务/13 生成/21 素材，47 个非数据库文件校验值不变，见 [优化验收](OPTIMIZATION_VALIDATION.md)。这些副本都未覆盖恢复到原目录，不包含升级后新增内容。

用现行 `m5-backup-check.ts` 检查 DB4 备份时，目标独立副本会被新代码迁移至 DB5；完整文件哈希是在迁移前比对，不代表迁移后的数据库二进制仍与备份相同。不要直接在唯一备份上运行会写数据库的程序。

## 恢复到当前项目：先保留现有 data

这是会改变当前运行数据的操作，仅在确实需要恢复时执行。先停全部服务，核实备份路径和版本；保留当前目录再恢复，不直接覆盖。以下是操作说明，本轮没有在原数据目录执行恢复。

```powershell
$ErrorActionPreference = 'Stop'
$taskRoot = (Get-Location).Path
$taskData = [IO.Path]::GetFullPath((Join-Path $taskRoot 'data'))
$taskBackup = (Resolve-Path -LiteralPath 'output/m5-stopped-data').Path
$taskBefore = [IO.Path]::GetFullPath((Join-Path $taskRoot ('data-before-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))))
if (-not $taskData.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar)) { throw '目标不在当前项目中' }
if (-not $taskBefore.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar)) { throw '保留目录不在当前项目中' }
if (Test-Path -LiteralPath $taskBefore) { throw '保留目录已存在，拒绝覆盖' }
if (-not (Test-Path -LiteralPath (Join-Path $taskBackup 'studio.sqlite'))) { throw '备份数据库不存在' }
if (Test-Path -LiteralPath $taskData) { Move-Item -LiteralPath $taskData -Destination $taskBefore }
Copy-Item -LiteralPath $taskBackup -Destination $taskData -Recurse
.\scripts\project.ps1 dev
```

重启后核对项目、角色/场景、镜头顺序、选用版本、媒体、任务和导出下载。恢复时真实开关保持 false；不通过重做生成来验证旧结果。失败时先停服务并保留失败现场，再恢复 `data-before-restore-*`。数据库版本须与代码匹配：M5 旧基线为 DB4，V1.6 当前为 DB5，项目文档仍为 4。当前没有 Git 首次提交，一键代码回退尚不可用。

若回退优化，必须先停服务并完整保留当前 DB5 数据，然后配套使用旧 82 文件代码与升级前 DB4 备份；不要只回退代码让旧程序读取 DB5。依赖未改变，可按同一锁文件安装；恢复本身不会撤销远端收费，也不能自动补发 unknown 任务。以上恢复步骤需要具体恢复需求与授权，不是本轮已执行操作。

`data-before-restore-*` 也含私有数据，已加入 `.gitignore`；保留副本不自动删除。
