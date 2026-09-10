# GIFP 永久免费发布路线

核对日期：2026-09-10。收费政策：GIFP 桌面软件永久免费下载、使用和升级；个人与商业用途继续按现有免费软件许可执行。代码修改、再分发与第三方组件的权利范围见 [LICENSE](../../LICENSE.txt)。

## 推荐交付

首发采用 **GitHub Releases + 完整 Windows 便携测试版 ZIP**，配套 SHA-256、使用说明、第三方许可证及对应运行时源码。随后增加安装版，成熟后评估 Microsoft Store。GitHub Releases 支持二进制附件；当前单个附件须小于 2 GiB，不必把安装包放入 Git 历史。[GitHub 官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

## 先澄清发布条件

- 永久免费是 GIFP 的收费政策；分发 FFmpeg 仍需满足所选构建的许可、对应源码与声明要求。FFmpeg 官方说明了 LGPL 与启用 GPL 组件后的区别，以及源码和实际二进制相对应的要求。[FFmpeg 官方说明](https://ffmpeg.org/legal.html)
- 当前代码通过独立 FFmpeg/FFprobe 进程处理媒体，Cargo 未直接链接 FFmpeg 库。这是评估独立组件分发的依据，但具体组合仍需按交互方式和许可判断，不能简单认定“用了 GPL 就必须把整个应用改成 GPL”，也不能认定外部调用免除所有义务。[GNU FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)
- 当前脚本强制使用公共 LGPL 配置，并要求特定质量报告、可复现构建记录和签名策略；这些是项目设置。基础正确性和第三方分发材料应作为首发条件，“第一梯队”评测宜作为独立的质量目标。本计划不直接改动校验结果或放开发行开关。

## 执行顺序

1. **固定免费表述。** README 明确永久免费；首页功能介绍保持 200 字以内，技术细节留在文档。
2. **完成 FFmpeg 9.0 公共运行时。** 复用现有 LGPL 构建配方和已通过校验的源码缓存，准备构建环境，生成运行时、组件清单与对应源码归档。当前终端未找到 Docker CLI；已有 A/B 输出为 `8.0.git`，不能当作本轮 9.0 验收证据。
3. **验收实际便携包。** 在干净环境检查启动、导入、剪辑、字幕贴纸、保存重开、录屏、主要格式导出与取消；确认依赖完整、版本一致、许可证齐全及文件校验通过。
4. **发布明确标记的公开测试版。** 包含完整 ZIP、校验值、对应源码与已知限制。没有签名时仅使用明确标记的 unsigned Alpha 路线，如实说明可能出现 Windows 安全提示；不要求用户关闭系统保护。
5. **改善正式安装体验。** 评估签名及 NSIS 安装包，再考虑商店渠道。安装包由 Tauri 的 Windows 分发链构建。[Tauri 安装包文档](https://v2.tauri.app/distribute/windows-installer/)

## 运行时方案取舍

| 方案 | 用户体验与工作量 | 建议 |
| --- | --- | --- |
| 完整 LGPL 便携包 | 下载解压即可用；需要完成 9.0 构建与验收 | 主路线 |
| 不捆绑 FFmpeg 的应用测试包 | 用户需另备兼容运行时；须补齐依赖引导和独立打包支持 | 仅作为技术体验者的过渡选项 |
| 直接分发现有 GPL full 包 | 仍需整理其全部相关组件、对应源码和分发条件；当前证据不完整 | 本轮不直接上传 |

## 免费软件的签名与渠道

签名不是“永久免费”的收费前提。未签名应用可能被 SmartScreen、Smart App Control 或企业策略阻止；新文件即使签名也可能需要积累信誉。微软 2026 年文档明确指出，EV 证书已不再自动消除 SmartScreen 提示，不应仅为此购买 EV。[微软 SmartScreen 说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

长期可评估 **Microsoft Store 的 MSIX 提交**：该路径由商店重新签名，无须自行购买签名证书；通过商店提交 MSI/EXE 则仍需发布者签名。上架还需开发者身份验证、包适配和商店审核，本轮没有创建商店账号或提交申请。[微软签名方案](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)

目前 GitHub 已提供 6.0.1 源码预览。当前本地便携包仍为 `internal`，本次文案和路线更新不代表 Windows 公开安装包已发布。
