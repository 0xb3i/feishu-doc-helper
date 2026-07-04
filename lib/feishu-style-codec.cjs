'use strict';

// Codec for Feishu's compact integer enums (color/align) shared between
// rendering, clipboard payload construction, and validation snapshots.

var FEISHU_BG_COLOR_TO_CSS = {
  1: '#fef2f2', 2: '#fff7ed', 3: '#fefce8', 4: '#f0fdf4',
  5: '#eff6ff', 6: '#faf5ff', 7: '#f9fafb',
  8: '#fecaca', 9: '#fed7aa', 10: '#fef08a', 11: '#bbf7d0',
  12: '#bfdbfe', 13: '#e9d5ff', 14: '#e5e7eb',
};

var FEISHU_TEXT_COLOR_TO_CSS = {
  1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e',
  5: '#3b82f6', 6: '#a855f7', 7: '#6b7280',
};

// Callout border_color uses a different palette than background_color.
var FEISHU_BORDER_COLOR_TO_CSS = {
  1: '#fecaca', 2: '#fed7aa', 3: '#fef08a', 4: '#bbf7d0',
  5: '#bfdbfe', 6: '#e9d5ff', 7: '#e5e7eb',
};

var EMOJI_MAP = {
  purple_heart: '💜', star: '⭐', sparkler: '🎇', fire: '🔥',
  light_bulb: '💡', warning: '⚠️', memo: '📝', check_box_with_check: '✅',
  exclamation: '❗', question: '❓', rocket: '🚀', gear: '⚙️',
  book: '📖', pin: '📌', clipboard: '📋', trophy: '🏆',
  thumbs_up: '👍', thumbs_down: '👎', heart: '❤️', boom: '💥',
  sun: '☀️', rainbow: '🌈', key: '🔑', lock: '🔒',
};

function buildReverseMap(map) {
  var reverse = {};
  Object.keys(map).forEach(function (key) {
    reverse[String(map[key]).toLowerCase()] = Number(key);
  });
  return reverse;
}

var CSS_TO_FEISHU_BG_COLOR = buildReverseMap(FEISHU_BG_COLOR_TO_CSS);
var CSS_TO_FEISHU_TEXT_COLOR = buildReverseMap(FEISHU_TEXT_COLOR_TO_CSS);
var CSS_TO_FEISHU_BORDER_COLOR = buildReverseMap(FEISHU_BORDER_COLOR_TO_CSS);

function isSafeCssColor(value) {
  return /^rgb(a)?\([\d\s.,%]+\)$/i.test(value || '')
    || /^#[0-9a-f]{3,8}$/i.test(value || '')
    || /^[a-z]+$/i.test(value || '');
}

function normalizeCssColor(value) {
  var num = Number(value);
  if (num > 0 && num <= 14 && FEISHU_BG_COLOR_TO_CSS[num]) return FEISHU_BG_COLOR_TO_CSS[num];
  if (num > 0 && num <= 7 && FEISHU_TEXT_COLOR_TO_CSS[num]) return FEISHU_TEXT_COLOR_TO_CSS[num];
  var trimmed = String(value || '').trim();
  return isSafeCssColor(trimmed) ? trimmed : '';
}

function normalizeTextAlign(value) {
  var num = Number(value);
  if (num === 1) return 'left';
  if (num === 2) return 'center';
  if (num === 3) return 'right';
  var trimmed = String(value || '').trim().toLowerCase();
  return /^(left|right|center|justify)$/.test(trimmed) ? trimmed : '';
}

function normalizeCssLength(value) {
  var trimmed = String(value || '').trim();
  return /^-?[\d.]+(px|em|rem|%)?$/.test(trimmed) ? trimmed : '';
}

function normalizeEmojiId(value) {
  return String(value || '').trim().toLowerCase();
}

function cssColorToHex(cssColor) {
  var trimmed = String(cssColor || '').trim();
  if (!trimmed) return '';
  if (trimmed.charAt(0) === '#') return trimmed;
  var rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgbMatch) return trimmed;
  var r = parseInt(rgbMatch[1], 10);
  var g = parseInt(rgbMatch[2], 10);
  var b = parseInt(rgbMatch[3], 10);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function cssColorToFeishuBgCode(cssColor) {
  if (!cssColor) return 0;
  var hex = cssColorToHex(cssColor);
  return hex ? (CSS_TO_FEISHU_BG_COLOR[hex.toLowerCase()] || 0) : 0;
}

function cssColorToFeishuBorderColorCode(cssColor) {
  if (!cssColor) return 0;
  var hex = cssColorToHex(cssColor);
  return hex ? (CSS_TO_FEISHU_BORDER_COLOR[hex.toLowerCase()] || 0) : 0;
}

function cssColorToFeishuTextCode(cssColor) {
  if (!cssColor) return 0;
  var hex = cssColorToHex(cssColor);
  return hex ? (CSS_TO_FEISHU_TEXT_COLOR[hex.toLowerCase()] || 0) : 0;
}

function alignStringToFeishuCode(alignStr) {
  if (alignStr === 'left') return 1;
  if (alignStr === 'center') return 2;
  if (alignStr === 'right') return 3;
  return 0;
}

function feishuCodeToAlignString(code) {
  var num = Number(code) || 0;
  if (num === 1) return 'left';
  if (num === 2) return 'center';
  if (num === 3) return 'right';
  return '';
}

function getEmoji(emojiId) {
  return EMOJI_MAP[emojiId] || '';
}

function getCalloutMarkdownType(snap) {
  var emojiId = normalizeEmojiId(snap && snap.emoji_id);
  if (emojiId === 'warning') return 'WARNING';
  if (emojiId === 'light_bulb' || emojiId === 'rocket' || emojiId === 'key') return 'TIP';
  if (emojiId === 'boom' || emojiId === 'thumbs_down') return 'CAUTION';
  if (emojiId === 'check_box_with_check' || emojiId === 'trophy' || emojiId === 'thumbs_up') return 'SUCCESS';
  if (emojiId === 'exclamation' || emojiId === 'question' || emojiId === 'gear' || emojiId === 'lock') return 'IMPORTANT';
  return 'NOTE';
}

function normalizeBlockStyle(snap) {
  var source = snap || {};
  return {
    align: normalizeTextAlign(source.align),
    textIndent: normalizeCssLength(source.text_indent),
    textColor: normalizeCssColor(source.text_color),
    backgroundColor: normalizeCssColor(source.background_color),
    borderColor: normalizeCssColor(source.border_color),
    imageAlign: normalizeTextAlign(source.align),
    calloutEmojiId: normalizeEmojiId(source.emoji_id),
  };
}

function resolveImageAlign(normalizedBlockStyle) {
  return normalizedBlockStyle && normalizedBlockStyle.imageAlign
    ? normalizedBlockStyle.imageAlign
    : 'center';
}

function selectPrimaryCalloutContent(snapshotContent, childContent) {
  var snapshotValue = String(snapshotContent || '').trim();
  var childValue = String(childContent || '').trim();
  return childValue || snapshotValue;
}

// Normalize an arbitrary CSS rgb() string into Feishu's canonical "rgb(R,G,B)"
// shape (no spaces).  Used when reading callout colors from the rendered DOM.
function normalizeCssRgb(value) {
  if (!value) return '';
  var match = String(value).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match) return 'rgb(' + match[1] + ',' + match[2] + ',' + match[3] + ')';
  return String(value);
}

module.exports = {
  CSS_TO_FEISHU_BG_COLOR: CSS_TO_FEISHU_BG_COLOR,
  CSS_TO_FEISHU_BORDER_COLOR: CSS_TO_FEISHU_BORDER_COLOR,
  CSS_TO_FEISHU_TEXT_COLOR: CSS_TO_FEISHU_TEXT_COLOR,
  EMOJI_MAP: EMOJI_MAP,
  FEISHU_BG_COLOR_TO_CSS: FEISHU_BG_COLOR_TO_CSS,
  FEISHU_BORDER_COLOR_TO_CSS: FEISHU_BORDER_COLOR_TO_CSS,
  FEISHU_TEXT_COLOR_TO_CSS: FEISHU_TEXT_COLOR_TO_CSS,
  alignStringToFeishuCode: alignStringToFeishuCode,
  cssColorToFeishuBgCode: cssColorToFeishuBgCode,
  cssColorToFeishuBorderColorCode: cssColorToFeishuBorderColorCode,
  cssColorToFeishuTextCode: cssColorToFeishuTextCode,
  cssColorToHex: cssColorToHex,
  feishuCodeToAlignString: feishuCodeToAlignString,
  getCalloutMarkdownType: getCalloutMarkdownType,
  getEmoji: getEmoji,
  isSafeCssColor: isSafeCssColor,
  normalizeBlockStyle: normalizeBlockStyle,
  normalizeCssColor: normalizeCssColor,
  normalizeCssLength: normalizeCssLength,
  normalizeCssRgb: normalizeCssRgb,
  normalizeEmojiId: normalizeEmojiId,
  normalizeTextAlign: normalizeTextAlign,
  resolveImageAlign: resolveImageAlign,
  selectPrimaryCalloutContent: selectPrimaryCalloutContent,
};
