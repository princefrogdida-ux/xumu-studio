# M4 中转站配置与本地使用

适用方案：V1.4。中转适配代码和本地协议测试已完成；具体中转站、模型效果及价格尚未实测。本轮保持 `STUDIO_REAL_CALLS_ENABLED=false`，不调用收费接口。

## 1. 兼容范围

| 类型 | 已实现协议 | 需要中转站满足的条件 |
|---|---|---|
| 文本分镜 | Chat Completions，非流式 JSON 响应 | Bearer 鉴权、`messages` 请求、`choices[0].message.content` 字符串 |
| 图片 | Images generations / edits | `model/prompt/n/size` 请求；`data` 返回相同数量的 `b64_json` 或 `url` |
| 参考图编辑 | 明确配置 JSON 或 multipart | JSON `images:[{image_url:data-url}]`，或重复的 `image[]` 文件字段 |
| 图生视频 | 服务端 JSON 任务模板 | Bearer、单张 data-url 首帧、字符串任务 ID、GET 查询、可映射状态和单个 MP4 下载地址 |

地址和模型可以按类型分别配置，能够使用同一家或不同中转站。协议名称相同并不保证模型参数、参考图和结果结构一致；当前不声称已经实测“大部分中转站”。

暂不适配 Responses 文本、通过聊天接口返回图片、Midjourney 等私有格式、视频 multipart、公网首帧 URL 上传流程、数字任务 ID、特殊签名鉴权及服务商额外必填参数。这些情况需要根据具体文档增加专用适配器。

## 2. 准备配置

安全操作：创建缺失的本地配置并预览能力。本地 `.env` 修改会影响重启后的 API 和 worker；不要覆盖已有配置，不要把密钥粘贴到聊天或前端字段。

```powershell
Set-Location 'D:\Users\work\codex project\project 2'
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
```

在本地编辑 `.env`，保留以下开关：

```dotenv
STUDIO_REAL_CALLS_ENABLED=false
```

各 `BASE_URL` 填写完整 API 根路径，例如 `https://relay.example/v1`，不包含具体 `/chat/completions` 或 `/images/generations`。程序不会自动补 `/v1`。示例域名和模型只是占位，不能直接调用。

生产配置要求 HTTPS，地址不能包含用户名、密码、查询参数或片段。鉴权固定为 `Authorization: Bearer <API_KEY>`。API 和 worker 仅从服务端读取密钥，能力接口不返回地址或密钥。`.env` 与 `config/*.local.json` 被 Git 忽略；不要在源码模板中填真实凭证。

环境变量优先于 `.env` 的既有加载逻辑；若曾在 PowerShell 设置同名变量，修改文件后仍应检查启动终端的设置。不要输出或截图密钥。

## 3. 文本服务

```dotenv
STUDIO_TEXT_BASE_URL=https://relay.example/v1
STUDIO_TEXT_API_KEY=
STUDIO_TEXT_MODEL=your-text-model
STUDIO_TEXT_FORMAT=prompt
STUDIO_TEXT_TIMEOUT_MS=120000
```

`FORMAT` 默认 `prompt`：在提示词里要求只返回分镜 JSON，不假定服务支持额外结构化参数。文档确认后可选 `json_object` 或 `json_schema`；选错会明确失败，不自动换格式再提交。超时毫秒数允许 1000～300000。

返回草稿严格校验全部字段及请求的 3～5 个镜头。有效草稿先预览，由用户明确追加或替换；格式错误保留脱敏诊断，不自动修改项目。

## 4. 图片服务

```dotenv
STUDIO_IMAGE_BASE_URL=https://relay.example/v1
STUDIO_IMAGE_API_KEY=
STUDIO_IMAGE_MODEL=your-image-model
STUDIO_IMAGE_EDIT_FORMAT=json
STUDIO_IMAGE_MAX_REFERENCES=0
STUDIO_IMAGE_MAX_COUNT=1
STUDIO_IMAGE_SIZES='{"1:1":"1024x1024","3:2":"1536x1024","2:3":"1024x1536"}'
STUDIO_IMAGE_MEDIA_HOSTS=
STUDIO_IMAGE_TIMEOUT_MS=120000
```

- `MAX_REFERENCES` 默认 0，只在确认模型支持参考图后设置为 1～8；总参考图文件最多 30 MiB。
- `MAX_COUNT` 默认 1，允许 1～4，应与该模型的实际候选上限一致。
- `SIZES` 是严格的比例到像素尺寸映射。1536×1024 为 3:2；模型不支持 16:9 时，界面不会显示该选项。若模型明确支持 1792×1008，可以配置 `"16:9":"1792x1008"`。配置不会验证服务商实际上支持该尺寸，仍需文档和实测。
- 无参考图调用 `/images/generations`；有参考图调用 `/images/edits`。JSON 格式发送内联 data-url；`EDIT_FORMAT=multipart` 使用 `image[]`，没有 mask 等额外编辑参数。不能因为第一种请求失败自动发第二种请求。
- 返回 Base64 可直接在本地保存；返回 URL 时，必须填写媒体下载主机，否则任务可能已经计费但无法保存结果。

主机允许列表示例：

```dotenv
STUDIO_IMAGE_MEDIA_HOSTS=cdn.relay.example,images.relay.example
```

只填写精确域名，逗号分隔；没有协议、路径或通配符。重定向的每个主机也必须列入。仅允许解析为公网地址的 HTTPS 下载，不向 CDN 转发 API 密钥。媒体下载不支持另加鉴权头；必须使用服务返回的可直接下载地址。下载和解码限制为每张 20 MiB、最多 4000 万像素的静态 PNG/JPEG/WebP。

## 5. 视频服务

模板是受限的字段映射，不是某家服务已经验证可用的配置。[示例文件](../config/video-profile.example.json) 的 `/video/jobs` 等路径仅用于说明和本地假服务测试。

```powershell
if (-not (Test-Path -LiteralPath 'config/video-profile.local.json')) {
    Copy-Item -LiteralPath 'config/video-profile.example.json' -Destination 'config/video-profile.local.json'
}
```

根据中转站官方文档编辑该本地文件，然后配置：

```dotenv
STUDIO_VIDEO_BASE_URL=https://relay.example/v1
STUDIO_VIDEO_API_KEY=
STUDIO_VIDEO_MODEL=your-video-model
STUDIO_VIDEO_PROFILE_FILE=config/video-profile.local.json
STUDIO_VIDEO_MEDIA_HOSTS=video-cdn.relay.example
STUDIO_VIDEO_POLL_MS=5000
STUDIO_VIDEO_TIMEOUT_MS=120000
```

| 模板字段 | 用途 |
|---|---|
| `submitPath` | 相对于完整 BASE_URL 的 POST 路径，如 `/video/jobs` |
| `queryPath` | GET 路径，包含 `{id}`；远端字符串 ID 替换到该位置 |
| `input` | 模型、提示词、首帧、时长和比例的请求字段名，可用点号表达嵌套字段 |
| `idPath` | 提交响应的字符串 ID 路径，如 `data.id` |
| `statusPath` | 查询响应状态路径，如 `data.status` |
| `outputUrlsPath` | 完成响应中的 URL 字符串或只含一个 URL 的数组 |
| `states` | running、succeeded、failed 各自的远端状态值，不能重叠，大小写准确匹配 |
| `durations` | 模型已核实支持的整秒时长列表，1～60 秒范围 |
| `ratios` | 模型已核实支持的比例列表 |

路径不能是外站 URL，也不允许模板脚本或原型字段。首帧固定发送为一个 data-url 字符串；时长发送为数字、比例发送为 `16:9` 等字符串；额外必填字段、对象格式首帧或其他类型转换需要专用适配。任务 ID 只接受 1～160 位字母、数字、下划线和连字符。

`POLL_MS` 范围为 1000～60000 毫秒。没有文档确认时使用 5000，后续按服务建议调整。URL 视频只接收单个 MP4，最多 100 MiB；容器校验不保证所有编码在浏览器都能播放，程序不转码。

## 6. 重启与预览

1. 停止本项目 dev，或分别停止 API 与 worker。保留 `.env` 中 false 开关。
2. 使用 `.\scripts\project.ps1 dev` 启动。生产运行需分别启动 `start` 与 `worker`，两者使用相同配置。
3. 打开 [本地画布](http://127.0.0.1:4310/)，选中生成卡片，选择“中转站 · 真实调用”，点击“刷新服务状态”。
4. 核对协议、模型、参考图数量、尺寸、时长及禁用说明。模型由服务端配置；历史节点保存的模型不同于当前配置时，可明确点击“使用服务端当前模型”。
5. false 开关下可查看已配置服务的输入摘要，但“真实调用未开启”按钮保持禁用，直接调用任务 API 也会被拒绝。

本轮不要开启真实调用。以后只有在具体服务、能力、凭证和费用额度已获授权时，才将开关改为 true 并重启 API 与 worker，先做单镜头低额度验收。程序不实现余额查询或金额硬限制；“费用未知”必须由账户额度、人工核实和操作范围共同控制。

## 7. 恢复、备份与异常

- 超时且没有私有回执：任务进入“待确认”，不自动再次 POST；先到中转站后台核实。“重新查询”只能利用已保存回执，不能猜测远端任务。
- 有回执或异步 ID：重启后继续查询；媒体下载失败重试下载并复用已有候选。“明确重试”会创建新任务，可能再次计费。
- 端点、模型或关键协议配置改变：旧任务不会改投新服务。恢复原配置再重新查询，或者检查新摘要后明确创建新任务。
- 结果链接过期：本地未保存的文件可能无法恢复，适配器不会自动重新生成；已保存素材使用稳定资产 ID，不依赖链接期限。
- `data/provider-results/` 保留同步二进制输出、远端 ID 和签名链接，服务端私有且不通过 API 暴露；其中可能有临时访问令牌，备份也应私下保管。回执不含 API_KEY，程序暂不自动清理。
- 完整备份覆盖整个 data：SQLite、media、provider-results；先停全部服务再复制。结构 JSON 导出不含媒体或完整任务状态，不能替代备份。回退需匹配旧代码与旧数据，详见 [验证记录](M4_VALIDATION.md)。

## 8. 本地验证命令

```powershell
.\scripts\project.ps1 typecheck
.\scripts\project.ps1 test
.\scripts\project.ps1 build
```

M4 自动测试注入 localhost 假服务和虚构密钥，不读取用户凭证或调用外部模型。生产配置没有允许 HTTP/内网调用的环境开关。

## 协议依据

2026-10-04 查阅 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Images 生成](https://developers.openai.com/api/reference/resources/images/methods/generate)及 [Images 编辑](https://developers.openai.com/api/reference/resources/images/methods/edit)，用作文本/图片协议依据；中转站实现仍需独立核实。

[Videos 官方历史页面](https://developers.openai.com/api/reference/resources/videos/methods/create)标注 Sora 2 与 Videos API 已于 2026-09-24 停用，未把该接口作为当前视频通用标准。模型名称相同也不能推断中转站仍具有相同服务能力。
