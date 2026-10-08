# Windows 安装与发布说明

应用版本 0.1.0，方案版本 1.7。本地预览版，适用于 Windows 10/11 x64，使用 Edge/Chrome 等现有浏览器。安装程序内置 Node.js 24.14.0 与生产依赖，无需另装 Node.js 或 pnpm。

## 下载与运行

1. 从 [GitHub Release](https://github.com/princefrogdida-ux/xumu-studio/releases/tag/v0.1.0) 下载 `Xumu-Studio-0.1.0-Windows-x64-Setup.exe`。
2. 运行安装程序；默认安装在 `%LOCALAPPDATA%\Programs\XumuStudio`，按当前用户安装，无需管理员权限。安装向导目前为英文，工作台为中文。
3. 在开始菜单打开“叙幕 Studio”；程序保留一个控制台窗口，并打开 `http://127.0.0.1:4311/`。如浏览器未自动打开，手动访问这个地址。
4. 在控制台输入 `stop` 并回车，等待正常停止；也可按 Ctrl+C。关闭网页不停止任务。备份或升级前先正常停止，避免直接关闭控制台窗口。

首发安装程序未进行代码签名，Windows 可能显示未知发布者提示。下载前确认仓库地址，可用下列 PowerShell 命令与 Release 的 `SHA256SUMS.txt` 比较：

```powershell
Get-FileHash .\Xumu-Studio-0.1.0-Windows-x64-Setup.exe -Algorithm SHA256
```

若端口已被源码版或其他应用占用，安装版会退出并给出提示，不终止其他进程。先停止自己的另一份叙幕 Studio，或在用户配置中设置不同的 `PORT`。新端口与浏览器草稿存储来源有关，修改前确认内容已保存到数据库。

## 数据、配置、升级与卸载

- 用户目录：`%LOCALAPPDATA%\XumuStudio`；数据库、媒体、任务与导出包在其 `data` 子目录。
- 私有配置：用户目录下的 `.env`。安装目录中的 `configuration.example.env` 仅为无密钥示例；复制时不要覆盖已有配置。视频模板路径建议填写用户目录中的绝对路径。
- 默认真正模型调用关闭。模拟图片带 MOCK 标识，模拟视频是固定 CC0 片段；真实模型效果、特定中转协议及费用尚未验收。
- 升级先输入 `stop`，再运行安装程序。检测到安装目录的 Node 正在使用时拒绝替换；停止后允许覆盖安装。
- 卸载保留整个用户目录，不删除项目、媒体或私有配置。重新安装后可继续读取；卸载本身不是备份。
- 完整备份须在 API 与 worker 全部停止后复制整个用户目录；JSON/素材 ZIP 不是完整备份。原源码版 `data` 不会自动迁入安装版，以免覆盖用户数据。

数据库版本 5、文档版本 4，本次发布无新增业务数据迁移。需要回退代码时保留当前用户目录，并匹配数据库版本，不能直接让不支持 DB5 的旧代码读取新库。详细备份原理见 [备份恢复](BACKUP_RESTORE.md)。

## 构建与验收

本轮在独立目录实际安装并逐文件核验，使用安装版 Node 与生产依赖启动空数据库，验证图片/视频 Mock、相同请求幂等、三镜头素材 ZIP 解压及 6 个媒体 SHA-256、剧情顺序、端口冲突保护、运行时拒绝覆盖安装、停止后覆盖安装、项目/任务重启恢复、卸载保留数据。原开发数据不参与安装测试，收费调用为 0。

类型检查、61/61 回归与生产构建通过。公开验收摘要见 [windows-0.1.0.json](validation/windows-0.1.0.json)。本机实际安装/升级/卸载和运行日志保留在 `output/releases/`，不随源码发布；本轮验证不是另一台物理电脑的人工体验验收。

源码构建流程（Windows x64）：

```powershell
.\scripts\project.ps1 install
.\scripts\project.ps1 build
# 准备官方 Inno Setup 6.7.3；指定实际 ISCC.exe 路径
$env:XUMU_ISCC = 'C:\Tools\Inno Setup 6\ISCC.exe'
# 将官方 Node v24.14.0/LICENSE 保存为 output/release-tools/node-LICENSE.txt
# 将官方 libvips x64 web static 8.18.7 包解压到 output/release-tools/libvips-dev
# 在解压目录中补充官方 THIRD-PARTY-NOTICES.md、GPL-3.0.txt、LGPL-3.0.txt
node scripts/build-windows.mjs
# 对脚本输出的新目录进行隔离验证，创建测试安装与卸载注册项
node scripts/verify-windows-release.mjs output/releases/build-<实际编号>
```

构建产物在每次新建的目录中，不覆盖已有包。版本固定于仓库、锁文件与构建脚本；构建时间/安装器元数据不同，因此不保证重新构建的 Setup 字节完全相同。验证脚本须在没有正式安装版的测试用户账户运行：Inno 固定 AppId 的卸载注册项按用户共用，不能用验收脚本覆盖正式安装记录。第三方源码与许可见 [THIRD_PARTY.md](../THIRD_PARTY.md)，本项目自身尚未指定开源许可。

