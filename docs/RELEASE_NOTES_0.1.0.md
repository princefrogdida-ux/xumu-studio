# 叙幕 Studio 0.1.0 · Windows 本地预览版

首次发布短剧制作工作台源码和 Windows x64 安装程序。已包含中文节点画布、剧本与分镜、共享角色/场景、素材管理、模拟图片/视频生成、持久化任务与历史版本、保存恢复，以及按镜头顺序导出的 ZIP/CSV/manifest。

## 下载安装

下载本页 `Xumu-Studio-0.1.0-Windows-x64-Setup.exe`，运行后从开始菜单打开“叙幕 Studio”。内置 Node.js 与依赖，无需额外安装开发环境；适用于 Windows 10/11 x64，安装向导为英文、工作台为中文。

程序使用浏览器访问 `http://127.0.0.1:4311/`，同时保留控制台。退出时输入 `stop` 并回车，等待正常停止；关闭网页不会停止任务。

## 数据与验证

数据位于 `%LOCALAPPDATA%\XumuStudio\data`，升级与卸载保留用户目录。首次安装为空项目，不包含开发者数据、密钥或任务历史。升级前先停止运行并备份用户目录。

类型检查、61 项回归及生产构建通过；实际安装后验证模拟图片/视频、三镜头 ZIP 的 6 个媒体文件校验、请求去重、端口冲突、覆盖安装、重启恢复和卸载保留数据。

## 已知限制

本版未进行代码签名，请核对本页 `SHA256SUMS.txt`。真实调用默认关闭，具体真实中转服务、模型效果与费用尚未验收；Mock 输出不是 AI 成品。该版本使用本地浏览器工作台，未包含时间线剪辑器、自动成片、多人协作或公网服务。

使用说明：[Windows 安装说明](https://github.com/princefrogdida-ux/xumu-studio/blob/main/docs/WINDOWS_RELEASE.md)。第三方许可与固定版本源码入口：[THIRD_PARTY.md](https://github.com/princefrogdida-ux/xumu-studio/blob/main/THIRD_PARTY.md)。

