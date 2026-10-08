# V1.6 操作与 API 增量

适用版本：应用 0.1.0、方案 1.6、文档 4、数据库 5。实际验证见 [优化验收](OPTIMIZATION_VALIDATION.md)。

## 使用方法

1. 分镜清单显示图片/视频选用与可交付状态。点击“准备图片节点”或“准备视频节点”，已有一个关联节点时直接定位，多个时明确选择；无节点时只创建当前镜头的结构。创建和重复点击不会生成，操作可撤销。
2. 任务面板和分镜/角色/场景的“查看节点”统一打开画布、选中并定位。记录仍在但卡片已删除时，需要明确同意才放入画布。
3. 历史默认 30 条，继续加载取下一页；查看固定输入才读取任务详情。很旧的当前选中版本独立读取。新任务不插进已打开的固定快照分页，需要刷新历史。
4. “供下游使用”与“镜头最终选用”分别表示节点输出选择和 Shot 交付选择。修改提示词/引用会提示输入变化，旧结果保留；切换选择不会生成。
5. JSON 外部素材缺失时，在素材恢复区选择本项目可用素材或上传文件。先看受影响引用与 checksum 差异；不同文件标为替代，应用只改当前编辑引用、一次撤销。生成来源不伪造，旧任务快照不改写。
6. 导入/导出区读取服务端打包历史，浏览器缓存清除后仍可查。成功包可重新下载；部分包保留问题。响应不明先“重新检查”找回服务端记录，不自动重建。没有运行中的包且重新检查通过后，允许明确点击打包。
7. 左侧健康信息分别显示 API、worker 心跳、活动任务与真实配置。排队加心跳缺失时启动 worker；心跳超过 20 秒不表示任务已失败。

正常停止 dev：在启动终端输入 `stop` 并回车，或按 Ctrl+C，等待“全部开发服务正常停止”。独立 API/worker 需各自在其终端停止。60 秒超时会报告强停，重启后检查待确认/打包失败状态；不要把强停当成完成备份准备。

只读检查：`.\scripts\project.ps1 doctor`。报告 Node/pnpm 版本、文件、权限、端口、健康和媒体/导出/优化备份空间，不读取密钥、不生成、不清理。自定义数据路径通过同名环境变量传给诊断命令；脚本本身不解析 .env。

## 增量 API

| 请求 | 返回与约束 |
|---|---|
| `GET /api/health` | ok、applicationVersion、planVersion、stage、schemaVersion、databaseVersion、now、worker.status/lastSeen、activeTasks、realCallsEnabled、invalidExportRecords |
| `GET /api/projects/:id/task-activity` | `{items,activeCount}`；当前节点最新摘要与最多 100 个活动任务摘要；activeCount 是数据库完整计数，不含输入快照/候选 |
| `GET /api/projects/:id/task-history?limit=30&nodeId=...&cursor=...` | `{items,nextCursor,snapshot}`；limit 1～100；nodeId 可选，cursor 是不透明 base64url；固定 rowid 边界倒序读取，跨项目或节点查询游标拒绝 |
| `GET /api/tasks/:id` | 单个完整公开任务，含固定输入快照，不含服务端私有回执 |
| `GET /api/projects/:id/generations/:generationId` | 当前项目单个生成版本；非本项目或不存在返回错误 |
| `GET /api/projects/:id/assets/:assetId?verify=1` | 归属校验后的单个素材；verify=1 对 ready 原文件做完整 SHA-256，失败标 damaged |
| `GET /api/projects/:id/exports?limit=30&cursor=...` | `{items,nextCursor,invalidRecordCount}`；1～100，按时间/ID 倒序，cursor 为返回记录 UUID；历史读取不新建包 |

TaskSummary 保留 id、projectId、nodeId、kind、mode、provider、model、status、inputFingerprint、时间、generationId、最长 500 字符 error、errorCode 和 actions.cancel/requery。前端根据稳定错误码与 actions 决定操作；新结果保存失败为 RESULT_SAVE_FAILED，旧中文前缀仅作兼容兜底。

旧 `GET /api/projects/:id/tasks` 仍返回完整 `{tasks,generations}`，未改变 worker/导出读取全集的行为。旧 ExportJob 没有 sources 时界面提示查看原清单；新记录在创建时固定 upload/mock/generated 来源，不依据当前项目重新标记旧包。失败下载不提供半成品。导入/创建/下载协议继续见 [M5 接口](M5_EXPORT_IMPORT.md)。

API 为请求产生本地 UUID，响应头 `X-RequestId`；错误响应保留 code/message/requestId。日志只含时间、请求标识、路由操作、方法、状态码/稳定错误码以及通过 UUID 校验的项目/任务标识，不记录完整提示词、body、鉴权头或私有 URL。诊断信息也不能作为私有回执导出。

前端活动轮询：活动约 1.2 秒、无活动前台约 10 秒、隐藏约 30 秒；焦点恢复/提交/手动刷新立即检查，同项目不重叠，项目会话序号阻止旧响应覆盖。worker 的远端查询节奏与并发保持原规则。
