---
name: 飞书文档迁移
description: 纯白浮纸、无边框柔光玻璃双主卡与极简单行信息流构成的 Chrome 扩展工具界面体系
colors:
  surface: "#ffffff"
  surface-soft: "#f7f7f9"
  surface-hover: "#f2f2f5"
  ink-primary: "#16161a"
  ink-secondary: "#55555e"
  ink-muted: "#8a8a93"
  ink-disabled: "#b5b5be"
  extract-indigo: "#5b6ff9"
  extract-indigo-soft: "#eef0ff"
  extract-indigo-ink: "#4658e0"
  paste-rose: "#fa52a9"
  paste-rose-soft: "#fff0f8"
  paste-rose-ink: "#d9388c"
  anchor-charcoal: "#1f1f23"
  anchor-charcoal-hover: "#2a2a30"
  warn-amber: "#d97706"
  warn-amber-soft: "#fef6e7"
  warn-amber-ink: "#a15405"
typography:
  action-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: "16.5px"
    fontWeight: 700
    lineHeight: 1.27
    letterSpacing: "-0.025em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.48
    letterSpacing: "-0.012em"
  anchor:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: "14.5px"
    fontWeight: 500
    lineHeight: 1.38
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.38
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.33
    fontFeature: "tnum"
rounded:
  xs: "9px"
  sm: "12px"
  md: "15px"
  lg: "20px"
  xl: "24px"
  full: "99px"
spacing:
  xs: "6px"
  sm: "14px"
  md: "18px"
  lg: "22px"
components:
  hero-action-extract:
    backgroundColor: "{colors.extract-indigo-soft}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.action-title}"
    rounded: "{rounded.lg}"
    padding: "25px 10px 18px"
  hero-action-paste:
    backgroundColor: "{colors.paste-rose-soft}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.action-title}"
    rounded: "{rounded.lg}"
    padding: "25px 10px 18px"
  cache-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    height: "46px"
    padding: "0 14px"
  anchor-cta:
    backgroundColor: "{colors.anchor-charcoal}"
    textColor: "{colors.surface}"
    typography: "{typography.anchor}"
    rounded: "{rounded.md}"
    height: "48px"
    padding: "0 18px"
---

# Design System: 飞书文档迁移

## Overview

**Creative North Star: "Luminous Sculpted Sheet"**

一整张纯白呼吸感浮纸（`#ffffff`），用大方外边距（`20px 22px 22px`）和克制的单行信息密度撑出高级感，彻底放弃灰底切栏的后台弹窗味。视觉重心只给两张无硬描边、柔光渐变的雕塑感主操作卡（靛蓝提取 + 柔粉粘贴）与底部哑光深炭黑锚定按钮，其余一切信息（当前文档、快照时间、缓存来源）收敛为安静的一行。

**Key Characteristics:**
- 纯白一体浮纸配 22px 呼吸外边距，不切灰底顶栏
- 两张主卡采用无硬描边轻透渐变 + 柔光内圈玻璃方徽 + 实心白标
- 顶栏与缓存栏严格收敛为极简单行，大幅降低视觉密度
- 底部哑光深炭黑按钮纯简居中，靠柔和宽阴影稳住整窗重心

## Colors

纯白与柔和中性灰构成安静留白，全界面只有「提取（靛蓝）」与「粘贴（柔粉）」释放通透色彩，非核心工具图标统一中性灰（Hover 加深）。

### Primary
- **Luminous Indigo** (`extract-indigo`): 「提取」主卡顶部轻透渐变、对称虚线网格纹、柔光玻璃方徽、进度条，以及图片浮层的选中描边与勾选徽标。

### Secondary
- **Candy Rose** (`paste-rose`): 「粘贴」主卡顶部轻透渐变、对称取景角标纹、柔光玻璃方徽与进度条。

### Neutral
- **Pure Sheet White** (`surface`): 弹出窗与图片浮层一体白底。
- **Soft Field Gray** (`surface-soft`): 空态缓存条、图片卡底托与禁用态柔灰按钮底。
- **Deep Ink** (`ink-primary`): 主动作标题、当前文档标题与缓存文档标题。
- **Calm Muted Gray** (`ink-muted`): 副标数字、时间戳、次级标签与默认工具图标。
- **Matte Charcoal** (`anchor-charcoal`): 底部「仅提取图片」与图片浮层「提取所选」哑光深色锚定按钮。

### Named Rules
**The Zero-Hard-Stroke Card Rule.** 主操作卡边缘不加生硬的彩色 1px 外描边，依靠顶部柔光渐变融入纯白底与宽幅浅彩漫反射落影自然浮起。

**The Single-Line Calm Rule.** 顶栏和缓存栏各自只保留单行核心信息（文档名 + 时间/刷新；缓存标签 + 来源名 + 时间/来自本页），域名等次要细节收入悬停提示，绝不堆叠两行后台元数据。

## Typography

**Display & Body Font:** 系统原生无衬线字体栈（`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC"`）。

### Hierarchy
- **Action Title** (`700`, `16.5px`, `-0.025em`): 主操作卡动词（提取 / 粘贴）。
- **Anchor** (`500`, `14.5px`, `-0.01em`): 底部哑光深炭黑按钮文案。
- **Heading** (`600`, `13.5px`): 顶栏当前文档名。
- **Body** (`500`, `13px`): 缓存文档名与通用按钮。
- **Meta** (`400`, `12px`, `tabular-nums`): 卡片副标数字与时间戳。

## Layout

- **弹出窗（348px 宽）**：单张纯白浮纸，内边距 `20px 22px 22px`。单行顶栏（下距 `18px`）→ 双列等宽主卡（`gap: 14px`, `min-height: 158px`, 下距 `16px`）→ 单行 `46px` 缓存栏（下距 `14px`）→ `48px` 居中深炭黑按钮。
- **图片选择浮层**：纯白居中圆角浮窗（最大 `960px × 680px`），自适应 `184px` 网格、`gap: 14px`。

## Elevation & Depth

纯白底面通过宽幅极柔漫反射阴影（主卡 `0 14px 30px -12px`，锚定按钮 `0 12px 24px -8px`）和柔光玻璃方徽内圈高光建立立体触感；暗色模式下取消一切彩色扩散光晕，统一使用纯中性暗影。

## Shapes

温润大圆角嵌套：外窗 `26px`、浮层 `24px`、主操作卡 `20px`、缓存条与底部按钮 `15px`、立体方徽 `14px`、全圆角状态胶囊 `99px`。

## Components

### Dual Hero Action Cards
- 无彩色外描边，顶部通透渐变融至纯白底；等比 SVG 背景纹居中不拉伸。
- `48px × 48px` 柔光玻璃方徽：径向高光核 + `2.5px` 半透明白内圈 + 实心纯白几何图形。
- 支持 Hover 上浮 `2px`、Active 按压、Disabled 安静浅灰退场、Busy 底边进度条、Confirm 4 秒倒计时。

### Single-Line Cache Bar
- `46px` 纯白细描边单行条（`1px solid rgba(18, 18, 24, 0.075)`），无重阴影、无右箭头，明确传达只读状态；触发覆盖确认时切为淡靛蓝高亮提示。

### Matte Charcoal Anchor CTA
- `48px` 哑光深炭黑（`#1f1f23`）纯简居中按钮，主文案白色配淡化副计数（`仅提取图片 · 4 张`），禁用时褪为无阴影浅灰条。

## Do's and Don'ts

### Do:
- **Do** 保持 `22px` 级大外边距与单行信息节奏，把视觉留白留给双主卡与深色锚定按钮。
- **Do** 主卡图标采用实心白标配柔光玻璃内圈，副标保持柔和中性灰。

### Don't:
- **Don't** 用深灰顶栏横线与灰底主体把轻量弹窗切碎成后台管理对话框。
- **Don't** 给彩色渐变卡加生硬彩色边框，或在底部深色按钮里塞多余图标、胶囊与右箭头。
- **Don't** 在顶栏或次级控件中引入杂乱语义色。
