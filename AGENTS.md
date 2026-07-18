# 项目约定

## 浏览器测试

- 可以使用 `canary-profile-browser` 连接本机 Chrome Canary，并通过 `agent-browser --cdp 9223` 控制带登录态的飞书页面。
- Canary 调试实例默认必须使用 `/Users/bytedance/chrome-agent-profile`，不要回退到默认 Canary profile。
- 该 profile 已手动加载过本项目未打包扩展；后续用同一 profile 重启 Canary 时，扩展应继续存在。不要把“Canary 能访问飞书”误判为“插件已加载”，测试插件前必须显式确认扩展注入状态。
- 本项目插件加载目录是 `dist/feishu-extension`。每次修改扩展源码后，先运行 `npm run build:feishu:extension`，再到 Canary 的 `chrome://extensions` reload 这个已加载扩展，然后刷新飞书文档页，否则页面仍可能运行旧 content script。
- reload 后至少用 `agent-browser --cdp 9223 eval --stdin` 在飞书文档页确认：`Boolean(window.__feishuHelperRuntime)` 为 `true`，且 `document.documentElement.getAttribute('data-feishu-helper-active')` 有值。
- 测试插件复制/粘贴流程时，源文档使用：`https://scnajei2ds6y.feishu.cn/wiki/AuzLwXbwNiw5WTkXlMJcQmtZnRD`。
- 测试插件复制/粘贴流程时，目标文档使用：`https://my.feishu.cn/wiki/Ga3PwhYVliu5v7kGk1YckNn3nwo`。
- 访问后至少确认当前 URL、页面标题和页面快照，避免误测登录页或空白页。
- 粘贴到目标文档并确认状态后，必须清除本次粘贴内容，方便下次重跑同一流程。

## 自动化调试流程

1. 运行 `/Users/bytedance/.codex/skills/canary-profile-browser/scripts/connect-canary-profile.sh`，后续所有浏览器命令都显式使用 `agent-browser --cdp 9223`。
2. 如果本轮改过扩展代码，先 `npm run build:feishu:extension`，再 reload Canary 中加载的 `dist/feishu-extension` 扩展，并刷新已打开的飞书文档页。
3. 打开源文档，等待页面稳定后先确认 `window.__feishuHelperRuntime` / `data-feishu-helper-active`，再触发插件提取，记录提取结果里的 `title`、`blockCount`、`textLen`、`htmlLen` 和 `semanticSnapshot`。
4. 打开目标文档，把焦点刻意放在非正文区域（例如 header button、popup 触发后的页面状态），再触发插件粘贴，确认目标标题、正文结构和关键内容是否与源文档一致。
5. 验证完成后清空目标文档里本次粘贴的内容，再重新读取页面快照确认清理完成。

## 提取约束

- 图片统计和图片提取面板只能使用飞书正文结构化数据里的图片记录（`docxRecord` / 复制 payload 中显式图片字段）。
- 正文结构里没有图片时，必须显示 0 或“未找到图片”；不要 fallback 到 DOM 扫描 `img`、背景图、头像、图标、模板缩略图等页面杂项。
- 右键单张“复制图片”可以继续基于当前鼠标命中的 DOM 元素工作；这和批量图片提取面板是两个入口，不要混在一起。
