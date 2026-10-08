# 第三方材料与源码

叙幕 Studio 的 Windows 0.1.0 安装包包含未经修改的 Node.js、JavaScript 生产依赖及 sharp Windows 原生库；前端由仓库锁文件中的依赖构建。各组件适用自己的许可。本项目自身尚未指定开源许可，不因此限制第三方组件许可授予的权利。

## 安装目录中的材料

- `runtime/LICENSE.txt`：Node.js 24.14.0 的完整许可与内置组件声明。[该版本源码与许可](https://github.com/nodejs/node/tree/v24.14.0)。
- `THIRD_PARTY_NOTICES.json`：实际打包生产依赖的名称、版本、许可和仓库。
- `node_modules/<包>/LICENSE*`：原包许可文件，生产依赖按锁定版本复制。
- `licenses/libvips/`：官方 Windows 附件的 LICENSE、README、版本清单，以及官方第三方声明、GPL/LGPL 文本；具体组件许可按原包声明执行。
- `node_modules/@img/sharp-win32-x64/versions.json`：原生库内部组件的精确版本。
- 本文件随包提供。安装器使用 [Inno Setup 6.7.3](https://github.com/jrsoftware/issrc/tree/is-6_7_3)，适用 [Inno Setup License](https://jrsoftware.org/files/is/license.txt)，安装器版权归其原作者。

模拟视频来自 [MDN flower.mp4 CC0 测试文件](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4)，声明也保留在 [fixtures/README.md](apps/server/src/fixtures/README.md)。模拟图片是本地几何图案，视频不是 AI 输出。

## sharp / libvips 对应源码

sharp 0.35.5 适用 Apache-2.0：[源码](https://github.com/lovell/sharp/tree/v0.35.5)。原生 DLL 含适用 LGPL 等许可的组件，其组件权利与应用代码分开。允许按相应许可修改或替换库，并为调试库修改进行所需的逆向工程；本应用不施加相反的限制。替换前停止程序并保留原文件，保持 DLL/ABI 兼容。

官方固定版本构建材料、补丁和下载规则：[libvips Windows 构建仓库 v8.18.7](https://github.com/libvips/build-win64-mxe/tree/v8.18.7)。sharp 的原生包制作入口：[sharp-libvips](https://github.com/lovell/sharp-libvips)。官方 Windows 附件：[vips-dev-x64-web-8.18.7-static.zip](https://github.com/libvips/build-win64-mxe/releases/download/v8.18.7/vips-dev-x64-web-8.18.7-static.zip)，SHA-256 为 `a736af61d3b46499760efa606e469cb14e060445b1f6fd36a1fa2e75009e1197`。

以下对应源码由原项目服务器免费提供；下载二进制的人也可以直接获取，不必购买或安装本应用。补丁及构建参数使用上述固定版本构建仓库，不用默认分支代替：

| 组件 | 对应版本源码 |
|---|---|
| libvips 8.18.7 | [libvips v8.18.7](https://github.com/libvips/libvips/tree/v8.18.7) |
| glib 2.90.0 | [glib-2.90.0.tar.xz](https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz) |
| fribidi 1.0.17 | [fribidi v1.0.17](https://github.com/fribidi/fribidi/tree/v1.0.17) |
| libexif 0.6.26 | [libexif v0.6.26](https://github.com/libexif/libexif/tree/v0.6.26) |
| libheif 1.23.5 | [libheif v1.23.5](https://github.com/strukturag/libheif/tree/v1.23.5) |
| librsvg 2.63.2 | [librsvg-2.63.2.tar.xz](https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.tar.xz) |
| pango 1.58.2 | [pango-1.58.2.tar.xz](https://download.gnome.org/sources/pango/1.58/pango-1.58.2.tar.xz) |
| proxy-libintl 0.5 | [proxy-libintl 0.5](https://github.com/frida/proxy-libintl/tree/0.5) |
| cairo 1.18.6 | [cairo-1.18.6.tar.xz](https://cairographics.org/releases/cairo-1.18.6.tar.xz) |

其他组件的版权与许可见安装目录 `licenses/libvips/` 及原生包 README、精确版本见 `versions.json`。这些原生二进制未由本项目修改。修改后的库可依官方构建入口重新编译，替换安装目录 `node_modules/@img/sharp-win32-x64/lib/` 中对应文件；上层 JavaScript 源码直接随安装包提供。
