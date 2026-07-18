# 飞书文档助手 Chrome 扩展

独立维护的 Manifest V3 Chrome 扩展，用于飞书 / Lark 文档复制、粘贴与图片提取。

## 开发

需要 Node.js `^20.19.0` 或 `>=22.12.0`（推荐使用仓库 `.nvmrc` 中的版本）。

```bash
npm install
npm test
npm run build
```

构建产物输出到 `dist/feishu-extension`，可在 Chrome / Edge 扩展管理页以 unpacked extension 加载。

## 目录

- `extension/`：扩展静态入口、popup UI、content bridge、service worker
- `extension/shared/protocol.js`：跨 popup、bridge 与 service worker 的消息和安全策略唯一真源
- `src/feishu-runtime/`：按数字顺序组装到 MAIN world 的页面运行时职责模块
- `lib/`：构建时内联到页面运行时的纯 helper
- `bin/build-feishu-extension.cjs`：生成 MV3 扩展产物
- `tests/`：纯函数、权限边界和构建契约测试

构建只向明确的飞书/Lark 文档路径注入脚本。待粘贴内容以扩展存储为唯一权威并在一小时后清理；页面公开事件不能在扩展用户动作之外读写该缓存。跨域图片读取只允许受信任右键手势命中的飞书图片 API/CDN，并限制类型、大小和超时。

`src/feishu-runtime/` 文件只允许依赖编号更小的模块；构建器按文件名排序组装，并在发现重复顶层符号时直接失败，避免通过拼接顺序形成隐式循环依赖。
