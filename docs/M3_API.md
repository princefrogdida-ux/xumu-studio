# M3 实际任务 API

对应方案 1.3，日期 2026-10-04（Asia/Shanghai）。仅本地模拟；默认 API `http://127.0.0.1:4311`。沿用项目、素材 API，以下为本阶段新增及已实施接口。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/providers/capabilities` | 当前 Mock 模型与限制，无凭证 |
| `POST /api/projects/:id/inputs` | 服务端解析已保存节点、校验输入文件，返回摘要、revision、fingerprint |
| `POST /api/projects/:id/tasks` | 固定输入并创建持久化任务，同 requestKey 返回原任务 |
| `GET /api/projects/:id/tasks` | 返回 `{ tasks, generations }`，含快照、错误、候选或分镜草稿 |
| `POST /api/tasks/:id/requery` | 明确重新查询 unknown 或保存失败的任务，不重新生成 |
| `POST /api/tasks/:id/retry` | 明确创建新任务，记录 retryOf；重新解析当前节点输入 |
| `POST /api/tasks/:id/cancel` | 只取消尚未被 worker 认领的 queued 任务 |

输入预览请求：

```json
{ "nodeId": "节点 ID" }
```

生成和明确重试请求：

```json
{
  "nodeId": "节点 ID",
  "requestKey": "本次点击生成的 UUID",
  "revision": 12,
  "inputFingerprint": "预览返回的 64 位 SHA-256"
}
```

请求超时或响应丢失时必须保留相同 requestKey，重发只确认同一任务。生成新版本或明确重试使用新 UUID；没有自动重试收费提交的路径。参数/项目变化返回 409，输入为空、未选上游图、图片损坏或模型未配置返回 400。

`requery`、`cancel` 为空 POST，不发送空 JSON 内容类型；`retry` 使用上述 JSON 请求体。Mock 的 requestKey 查找仅用于持久化本地远端模拟记录，不代表真实服务具有远端幂等或找回能力。

版本与最终镜头选择使用 `PUT /api/projects/:id/document` 保存节点的 `selectedGenerationId`、`selectedAssetId` 和 Shot 的 `selectedImageAssetId` / `selectedVideoAssetId`。服务端验证素材归属、类型和生成版本所属节点，旧 revision 仍返回冲突；不创建任务、不改变任务状态。

任务与生成记录独立于编辑文档，删除节点保留历史。结构 JSON 导出不含任务、草稿历史或媒体原文件。完整备份需保留数据库与整个媒体目录。
