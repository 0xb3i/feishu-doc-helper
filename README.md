# 飞书文档助手 Chrome 扩展

独立维护的 Manifest V3 Chrome 扩展，用于飞书 / Lark 文档复制、粘贴与图片提取。

## 开发

```bash
npm install
npm test
npm run build
```

构建产物输出到 `dist/feishu-extension`，可在 Chrome / Edge 扩展管理页以 unpacked extension 加载。

## 目录

- `extension/`：扩展静态入口、popup UI、content bridge、service worker
- `src/feishu-runtime/`：注入 MAIN world 的页面运行时代码片段
- `lib/`：构建时内联到页面运行时的纯 helper
- `bin/build-feishu-extension.cjs`：生成 MV3 扩展产物
- `tests/`：构建契约测试
