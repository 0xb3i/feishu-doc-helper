# 飞书文档助手 Chrome 扩展

独立维护的 Manifest V3 Chrome 扩展，用于飞书 / Lark 文档复制、粘贴与图片提取。

## 开发

需要 Node.js `^20.19.0` 或 `>=22.12.0`（推荐使用仓库 `.nvmrc` 中的版本）。

```bash
npm install
npm test
npm run build
npm run install:native-host
```

构建产物输出到 `dist/feishu-extension`，可在 Chrome / Edge 扩展管理页以 unpacked extension 加载。

跨账号画板迁移使用飞书官方 OpenAPI：扩展通过 Chrome Native Messaging 调用本机
`lark-cli`，不会读取或复制浏览器 Cookie、Authorization。首次使用前请确认
`lark-cli whoami` 显示用户身份可用；首次安装 Host 后需要完全退出并重新打开 Chrome / Chrome Canary，
再重新加载 unpacked extension 并刷新文档页。仅 reload 扩展不足以让已运行的浏览器发现新安装的 Host。
默认复用当前 CLI 身份；只有不同域名确实需要不同 CLI profile 时，才额外运行：

```bash
npm run install:native-host -- --map bytedance.sg.larkoffice.com=corp --map my.feishu.cn=personal
```

映射只接受已经存在且用户 OAuth 校验通过的 profile；安装器会逐一验证，缺失、未授权或
登录失效都会直接停止安装。配置映射前先用 `lark-cli profile list` 确认 profile，并分别用
`lark-cli auth status --verify --profile <name>` 检查登录态。若默认身份已经能访问源、目标
文档，不要额外配置映射。

## 使用

1. 在企业账号可访问的源文档中打开扩展，点击“提取文档”，等待画板导出完成。
2. 切换到个人账号可编辑的目标文档，打开扩展并点击“粘贴副本”。
3. 等待进度完成；扩展会先粘贴正文，再通过 Native Host 在占位位置创建并导入画板。

如果源、目标分别只能由不同 CLI 用户写入，先为两个用户准备独立且已授权的 `lark-cli`
profile（`lark-cli profile add --help`、`lark-cli auth login --help`），再使用上面的 `--map`
重新安装 Host。扩展不复用浏览器登录 Cookie，因此“浏览器同时登录两个账号”不能替代
CLI profile 的用户 OAuth 授权。

## 目录

- `extension/`：扩展静态入口、popup UI、content bridge、service worker
- `extension/shared/protocol.js`：跨 popup、bridge 与 service worker 的消息和安全策略唯一真源
- `native-host/`：官方文档/画板 API 的 Native Messaging Host、安装器与事务回滚
- `src/feishu-runtime/`：按数字顺序组装到 MAIN world 的页面运行时职责模块
- `lib/`：构建时内联到页面运行时的纯 helper
- `bin/build-feishu-extension.cjs`：生成 MV3 扩展产物
- `tests/`：纯函数、权限边界和构建契约测试

构建只向明确的飞书/Lark 文档路径注入脚本。待粘贴内容以扩展存储为唯一权威并在一小时后清理；页面公开事件不能在扩展用户动作之外读写该缓存。跨域图片读取只允许受信任右键手势或扩展提取操作访问受控飞书图片 API/CDN，并限制类型、大小和超时。

`src/feishu-runtime/` 目前在同一个闭包中按编号顺序组装；编号表示初始化顺序，不构成模块隔离。函数之间可通过声明提升相互引用，顶层初始化只能读取已初始化的状态。构建器检查重复顶层符号；新增可独立验证的领域逻辑优先放入 `lib/`，页面适配与生命周期保留在运行时。

图片面板直接遍历正文结构树，不渲染全文或扫描页面图片。提取时按 token 去重下载，最多并发 5 个请求，统一替换 HTML；粘贴后通过编辑器 Data Service 确认图片注册及归位。右键单图仍只处理用户命中的图片。

缓存读取、写入和过期清理共用串行队列，避免清理操作删掉刚提取的文档。提取中的样式补全只写入导出数据，不修改源编辑器记录。Native Host 源码修改后，除构建扩展外还需重新运行安装命令更新本机运行副本。
