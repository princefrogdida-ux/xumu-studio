# M4 实际 API 与数据变更

适用方案：V1.4，文档/数据库版本 4。任务创建、查询、取消、明确重试和选择版本的路径沿用 [M3 API](M3_API.md)；以下描述已经实现的增量，不把开发方案中的草案端点当作已有接口。

## 健康与能力

`GET /api/health` 返回：

```json
{"ok":true,"mode":"configurable","stage":"M4","schemaVersion":4}
```

`GET /api/providers/capabilities` 保留旧版 mock 顶层字段以兼容旧客户端，新增 `providers` 数组；混合模式客户端应读取该数组，而非用顶层 `mode` 推断全站模式。

每类包含一个 mock 与一个 relay 能力，共六条。ProviderId 为 `mock`、`relay-script`、`relay-image`、`relay-video`，以 `kind` 区分 script/image/video。

| 字段 | 含义 |
|---|---|
| `provider/kind/mode/model/protocol` | 服务标识、类型、mock/real、服务端配置模型及协议 |
| `configured` | 配置已通过本地结构校验；不表示外部服务实测可用 |
| `enabled` | 本地执行许可；真实服务须配置有效且开关精确为 true |
| `serviceId` | 真实配置的 SHA-256 摘要，可选，不含密钥 |
| `message` | 中文配置或执行状态 |
| `maxReferences/maxCount` | 参考图和图片候选能力上限 |
| `ratios/sizes/durations/pollIntervalMs` | 可用参数和查询间隔；文本类部分列表为空 |

API 不返回 BASE_URL、API_KEY、鉴权头、下载允许列表、视频模板物理路径或完整模板。

## 节点与输入快照

生成节点 `data.mode` 可为 mock 或 real；没有该字段的旧节点按 mock 解析。界面模式与模型参数通过项目文档 PUT/revision 保存，不创建任务。

`POST /api/projects/:id/inputs` 仍接收 `{"nodeId":"..."}`，返回 revision、inputSnapshot 和 inputFingerprint。已配置且关闭真实开关时可以预览；缺失配置、不支持的比例、超过候选/参考图能力、损坏素材或无首帧会拒绝预览。

真实图片快照示例（仅示意，未提交收费请求）：

```json
{
  "mode":"real",
  "provider":"relay-image",
  "kind":"image",
  "model":"your-image-model",
  "prompt":"雨夜街道",
  "imageAssetIds":[],
  "serviceId":"配置摘要，实际为64位十六进制",
  "params":{"ratio":"1:1","count":1,"size":"1024x1024"},
  "scenario":"success"
}
```

文本 params 为 shotCount，视频为 ratio/duration。快照只保存本地稳定素材 ID，不存 Base64 或远端素材 URL。模拟快照保持 M3 字段形状以保留旧 fingerprint。

`POST /api/projects/:id/tasks` 请求体保持 `nodeId/requestKey/revision/inputFingerprint`。后端重新解析输入与素材并校验配置/开关；真实关闭时拒绝创建新任务。重复已存在的 requestKey 返回原任务，不重新执行。worker 在执行时再次验证权限、素材和 serviceId，防止浏览器绕过或队列期间配置变化。

## 结果、回执与恢复

- Task.kind/provider/model/inputSnapshot 记录本次实际模式。`providerTaskId` 为 `relay:<本地任务 UUID>`；原始视频远端 ID、签名 URL 和同步输出放在私有回执，不通过任务 API 返回。
- `GET /api/projects/:id/tasks` 的 generations 结构保持不变；真实草稿 `draft.mode=real`，模拟仍为 mock。有效草稿先预览，应用属于编辑动作。
- Asset.source 增加 `generated`，原 upload/mock 保持不变。真实媒体先下载、校验和保存，再发布成功历史。素材 API 继续使用稳定本地 asset ID。
- `POST /api/tasks/:id/requery` 只恢复已有回执/ID的查询及保存，不提交新生成；没有可确认回执时保留 unknown，返回需人工核实的错误。
- `/retry` 创建新的关联任务并重新校验当前摘要；可能产生新费用。取消只限 queued 且未认领任务，没有实现远端取消。
- 原始中转 HTTP 错误体不会写入日志或返回前端；文本失败诊断经过密钥、Bearer 与 URL 脱敏。服务配置错误不回显配置值。

M4 没有增加密钥编辑 API、余额查询、金额硬限制、任意 URL 下载或任意模板执行接口。具体配置和已知兼容边界见 [配置说明](M4_CONFIGURATION.md)。
