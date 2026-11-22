<div align="center">

<img src="assets/icon.png" width="96" height="96" alt="飞书文档助手图标">

# 飞书文档助手

用于飞书 / Lark 文档提取、粘贴与跨账号迁移的 Chrome 扩展。

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-manifest-v3)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

</div>

## 产品概览

飞书文档助手把文档迁移拆成「提取」和「粘贴」两个动作。你可以从当前飞书文档提取正文、图片和画板信息，将内容保存在扩展缓存中，再切换到另一个可编辑的文档完成粘贴。跨账号画板迁移由浏览器端重建画板，本机 Native Host 负责调用 `lark-cli` 读取源文档和画板元数据。

## 核心能力

- 提取飞书 / Lark 文档正文，并在目标文档中写入
- 从正文结构中识别图片，支持预览、勾选和批量提取
- 统计当前文档中的画板数量，并支持跨账号迁移
- 使用缓存区连接源文档和目标文档，显示缓存内容与更新时间
- 粘贴时恢复正文、图片和画板占位关系
- 提供快照刷新、操作进度、Toast 提醒和错误状态
- 通过扩展消息边界限制页面注入、缓存访问和 Native Messaging 调用

## 使用流程

1. 在源飞书文档打开扩展，点击「提取文档」。
2. 等待正文、图片和画板信息进入缓存区。
3. 切换到目标飞书文档，打开扩展并点击「粘贴副本」。
4. 等待正文写入和画板导入完成。

源文档和目标文档可以属于同一个账号，也可以属于不同企业或不同账号。目标账号需要具备目标文档的编辑权限。

## 安装与构建

环境要求为 Node.js `^20.19.0` 或 `>=22.12.0`。在项目目录执行：

```bash
npm install
npm test
npm run build
```

构建产物位于 `dist/feishu-extension`。在 Chrome 或 Edge 的扩展管理页开启「开发者模式」，选择「加载已解压的扩展程序」，加载该目录。

## Native Host 配置

跨账号画板迁移需要本机安装 Native Messaging Host，并通过 `lark-cli` 使用已授权的身份读取飞书 OpenAPI 数据：

```bash
npm run install:native-host
lark-cli whoami
```

安装器会把当前项目中的 Native Host 源码和运行时依赖安装到本机。修改 `native-host/` 后，需要重新执行安装命令。首次安装或更新 Host 后，请完全退出并重新打开 Chrome，再重新加载扩展并刷新飞书文档页面。

默认使用当前 `lark-cli` 身份。如果源文档和目标文档需要不同的 CLI profile，可以按域名配置映射：

```bash
npm run install:native-host -- \
  --map bytedance.sg.larkoffice.com=corp \
  --map my.feishu.cn=personal
```

映射中的 profile 必须已经存在并通过 OAuth 校验。可先使用以下命令检查：

```bash
lark-cli profile list
lark-cli auth status --verify --profile <name>
```

扩展不会读取或复制浏览器 Cookie、`Authorization` 或其他浏览器登录凭据。

## 项目结构

```text
extension/                 Chrome 扩展入口、Popup、页面 Bridge 与 Service Worker
extension/popup/            当前版本的弹窗 UI
extension/shared/           Popup、Bridge、Service Worker 共用协议与工具
extension/content/          图片选择面板与页面内容适配
native-host/                Native Messaging Host、安装器与飞书 API 调用
src/feishu-runtime/         注入飞书页面 MAIN world 的运行时模块
lib/                        构建时内联的纯函数和迁移辅助模块
bin/                        扩展构建与本地重载脚本
tests/                      运行时、构建、安全边界和迁移测试
assets/                     产品图标资源
```

## 测试

```bash
npm test
```

测试覆盖文档结构处理、图片提取、缓存和粘贴流程、画板迁移、Service Worker、扩展构建契约及安全边界。
