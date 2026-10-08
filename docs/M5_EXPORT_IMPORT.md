# M5：结构导入与素材交付

依据 V1.5，2026-10-04（Asia/Shanghai）。本地单人模式，不调用模型；真实服务仍待验收。

## 界面操作

1. 顶栏点击“导入 / 导出”。操作前会等待当前项目保存；保存失败/冲突时先保留草稿并解决保存状态。
2. “检查素材包”列出镜头数、文件数、体积和具体缺失项。完整包按钮仅在无问题时可用。
3. 如需部分交付，明确勾选“仅导出已有素材，并在清单中保留全部缺失项”，再打包。缺失镜头仍在 CSV 和 manifest 中。
4. 打包成功后下载 ZIP；可关闭窗口/刷新后重开找回最近一次导出。检查后修改项目或文件会使摘要失效，需要重新检查。
5. “导出 JSON 结构”下载已保存的项目结构。保存冲突时，画布错误栏的“导出草稿”仍可离线保留未同步内容。
6. 导入可以选 `.json` 文件或粘贴内容，最大 2 MiB。先校验，成功后创建并打开新项目，显示素材/历史说明；不覆盖原项目。

同一数据目录导入可继续引用原项目授权的素材。换电脑或原素材缺失时，会显示缺失占位记录；重新上传文件后，在角色/场景、镜头和素材节点里明确替换引用。不自动获取远端 URL，不执行生成或带入任务历史。

## ZIP 内容与边界

```text
manifest.json
storyboard.csv
shots/
  001_02_<镜头ID摘要>/
    001_02_<镜头ID摘要>_image.png
    001_02_<镜头ID摘要>_video.mp4
references/
  <素材UUID>.png
```

`001` 是剧情顺序，`02` 是手工镜头编号；调整顺序不会移动画布卡片。编号特殊字符会被清理，重复编号不会覆盖文件。清单包含原镜头 ID、选用资产、SHA-256、原始镜头提示词和可获得的任务固定输入、模型、参数、版本及来源。没有任务来源时 `provenance: null`，不补造历史。

来源 `mock` 为本地模拟，`upload` 为上传，`generated` 为接口产出；接口来源不等于模型质量或真实闭环已验收。模拟视频是固定 CC0 片段。ZIP 是可交给后续剪辑的有序素材，不是成片，也不包含完整数据库任务/回执。

CSV 使用 UTF-8 BOM，兼容 Windows 表格软件；公式形态文字前加单引号，原文仍保留在 manifest。图片/视频使用已有格式限制，包内媒体总量最多 1 GiB；同一媒体用于多个镜头会重复打包。单 API 实例一次打包一个包，不自动清理历史包。磁盘不足、文件在打包时变化、服务中断时明确失败，不提供半成品，不自动重建。

## 实际 API

| 方法与路径 | 请求 / 返回 |
|---|---|
| `GET /api/projects/:id/structure` | JSON 结构快照，无媒体/任务/服务端私有字段 |
| `POST /api/projects/import` | 结构 JSON；201 `{project,warnings,missingAssetIds}` |
| `POST /api/projects/:id/exports/preview` | 无请求体；返回 revision、fingerprint、shots/files/bytes 统计与 issues |
| `POST /api/projects/:id/exports` | `{revision,fingerprint,allowPartial:false}`；202 ExportJob |
| `GET /api/exports/:id` | building / succeeded / failed，缺失项、错误及完成文件 size/checksum |
| `GET /api/exports/:id/file` | 仅成功且校验通过时下载 ZIP |

创建打包时有缺失且 `allowPartial=false`，返回 422 / `EXPORT_INCOMPLETE`，附 preview。revision 或摘要变化返回 409。无效导入返回 400，超过 2 MiB 返回 413；导入失败不创建半成品项目。未知素材路径、远端 URL 字段和任意额外私有字段不属于支持格式。

JSON 顶层支持 `format:'drama-studio-structure'`、`formatVersion:1`、`name`、`document`、`sourceProjectId?`、`assets`、`note?`。素材清单只允许 ID、名称、媒体类型、MIME、大小、SHA-256、来源、创建时间与可选宽高。旧 `{name,document,note?}` 可导入，document 版本 1～3 在严格校验后升级为 4，未知版本拒绝。

导出文件保存在配置数据目录 `exports/`，不向 API 返回物理路径。ExportJob 不提交给生成 worker；模型任务数量不因导入、检查、导出或刷新增加。

## 完整模拟案例

本地项目“雨夜来信 · M5 完整模拟交付”有三镜头、共享角色与场景，8 个模拟任务。首镜头图片生成两次后选第二次的第二个候选；三个镜头均明确选用图片和视频，清单剧情顺序为 `02 → 01 → 03`。

交付文件位于 `output/m5/`，运行数据和文件不随源码提交。可以在隔离的新目录复现：

```powershell
node --import tsx scripts/m5-local-case.ts output/m5/case-data
```

脚本只实例化 MockProvider，不加载 `.env`；已存在同名案例或验证备份目录时拒绝覆盖。对现有 data 操作前必须停本项目全部服务，存在未完成任务时拒绝运行。不要把复现脚本用于不明确的其他数据目录。

验证范围见 [M5_VALIDATION.md](M5_VALIDATION.md)，完整备份/恢复见 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)。
