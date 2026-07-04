'use strict';

// Encode/decode helpers for Feishu's clipboard attribute streams ("docx/text"
// payloads).  Pure functions, used both by the userscript bundle and by tests.

function isFormulaBoundaryWordChar(ch) {
  return !!ch && /[0-9A-Za-z_À-ɏ⺀-鿿]/.test(ch);
}

function normalizeEquationLatex(latex) {
  var value = String(latex == null ? '' : latex);
  if (value.endsWith('\\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  return value.trim();
}

function splitLatexSegments(text) {
  var source = String(text || '');
  var segments = [];
  var cursor = 0;
  var index = 0;

  while (index < source.length) {
    if (source[index] !== '$' || (index > 0 && source[index - 1] === '\\')) {
      index++;
      continue;
    }

    var delimiter = source[index + 1] === '$' ? '$$' : '$';
    var openLen = delimiter.length;
    var scan = index + openLen;
    var closeIndex = -1;

    while (scan < source.length) {
      if (source[scan] === '\\') {
        scan += 2;
        continue;
      }

      if (delimiter === '$$') {
        if (source[scan] === '$' && source[scan + 1] === '$') {
          closeIndex = scan;
          break;
        }
        scan++;
        continue;
      }

      if (source[scan] === '$' && source[scan + 1] !== '$') {
        closeIndex = scan;
        break;
      }
      scan++;
    }

    if (closeIndex === -1) {
      index += openLen;
      continue;
    }

    if (cursor < index) {
      segments.push({ type: 'text', value: source.slice(cursor, index) });
    }

    segments.push({
      type: 'formula',
      value: normalizeEquationLatex(source.slice(index + openLen, closeIndex)),
      delimiter: delimiter,
    });

    index = closeIndex + openLen;
    cursor = index;
  }

  if (cursor < source.length) {
    segments.push({ type: 'text', value: source.slice(cursor) });
  }

  if (!segments.length) {
    segments.push({ type: 'text', value: source });
  }

  return segments;
}

function findNextNonWhitespaceChar(segments, startIndex) {
  for (var i = startIndex + 1; i < segments.length; i++) {
    var segment = segments[i];
    if (!segment || !segment.value) continue;
    for (var j = 0; j < segment.value.length; j++) {
      if (!/\s/.test(segment.value[j])) return segment.value[j];
    }
  }
  return '';
}

function normalizeLatexTextBoundaries(text) {
  var segments = splitLatexSegments(text);
  var out = '';

  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i];
    if (segment.type === 'text') {
      out += segment.value;
      continue;
    }

    var formula = segment.delimiter + segment.value + segment.delimiter;
    var prevChar = out ? out[out.length - 1] : '';
    var nextChar = findNextNonWhitespaceChar(segments, i);
    var prefix = isFormulaBoundaryWordChar(prevChar) ? ' ' : '';
    var suffix = isFormulaBoundaryWordChar(nextChar) ? ' ' : '';
    out += prefix + formula + suffix;
  }

  return out.replace(/[ \t]{2,}/g, ' ');
}

function normalizeLatexForHtml(text) {
  var segments = splitLatexSegments(text);
  var out = '';

  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i];
    if (segment.type === 'text') {
      out += segment.value;
      continue;
    }

    var formula = '$$' + segment.value + '$$';
    var prevChar = out ? out[out.length - 1] : '';
    var nextChar = findNextNonWhitespaceChar(segments, i);
    var prefix = prevChar && /\s/.test(prevChar) ? '' : ' ';
    var suffix = nextChar && /\s/.test(nextChar) ? '' : ' ';
    out += prefix + formula + suffix;
  }

  return out.replace(/[ \t]{2,}/g, ' ');
}

function containsLatexText(text) {
  return /\$\$[\s\S]+?\$\$|\$(?:\\.|[^$\n])+\$/.test(String(text || ''));
}

function normalizePlainText(text) {
  return String(text || '')
    .split(/(```[\s\S]*?```)/g)
    .map(function (part) {
      if (part.startsWith('```') && part.endsWith('```')) return part;
      return part
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/^[ \t]+$/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    })
    .join('')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Read a single Feishu attrib stream (`*<num36>+<count36>...`) into a flat
// markdown string.  textStr supplies the raw text characters; numToAttrib maps
// attrib indices to `[name, value]` tuples produced by Feishu's apool.
function decodeFeishuAttribs(attribsStr, textStr, numToAttrib) {
  var result = [];
  var textIdx = 0;
  var i = 0;
  attribsStr = String(attribsStr || '');
  textStr = String(textStr || '');
  numToAttrib = numToAttrib || {};

  while (i < attribsStr.length) {
    var attrs = [];
    while (i < attribsStr.length && attribsStr[i] === '*') {
      i++;
      var numStr = '';
      while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
        numStr += attribsStr[i];
        i++;
      }
      var num = parseInt(numStr, 36);
      if (numToAttrib[num]) attrs.push(numToAttrib[num]);
    }

    if (i < attribsStr.length && attribsStr[i] === '+') {
      i++;
      var countStr = '';
      while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
        countStr += attribsStr[i];
        i++;
      }
      var count = parseInt(countStr, 36);

      var equationAttr = null;
      var linkAttr = null;
      var isBold = false;
      var isItalic = false;
      var isStrike = false;
      var isInlineCode = false;

      for (var ai = 0; ai < attrs.length; ai++) {
        var a = attrs[ai];
        if (a[0] === 'equation') equationAttr = a;
        else if (a[0] === 'link') linkAttr = a;
        else if (a[0] === 'bold' && a[1] === 'true') isBold = true;
        else if (a[0] === 'italic' && a[1] === 'true') isItalic = true;
        else if (a[0] === 'strikethrough' && a[1] === 'true') isStrike = true;
        else if (a[0] === 'inlineCode' && a[1] === 'true') isInlineCode = true;
      }

      var rawText = textStr.substring(textIdx, textIdx + count);

      if (equationAttr) {
        result.push('$' + normalizeEquationLatex(equationAttr[1]) + '$');
      } else {
        var segment = rawText;
        if (isInlineCode) segment = '`' + segment + '`';
        if (isBold) segment = '**' + segment + '**';
        if (isItalic) segment = '*' + segment + '*';
        if (isStrike) segment = '~~' + segment + '~~';
        if (linkAttr) {
          var href = decodeURIComponent(linkAttr[1] || '');
          segment = '[' + segment + '](' + href + ')';
        }
        result.push(segment);
      }

      textIdx += count;
    } else {
      break;
    }
  }

  if (textIdx < textStr.length) {
    result.push(textStr.substring(textIdx));
  }

  return normalizeLatexTextBoundaries(result.join(''));
}

// HTML variant.  Accepts a `colorize` callback so the caller can plug in its
// own colour normaliser; defaults to passing values through unchanged.
function decodeFeishuAttribsToHtml(attribsStr, textStr, numToAttrib, options) {
  var result = [];
  var textIdx = 0;
  var i = 0;
  attribsStr = String(attribsStr || '');
  textStr = String(textStr || '');
  numToAttrib = numToAttrib || {};
  var normalizeColor = (options && typeof options.normalizeColor === 'function')
    ? options.normalizeColor
    : function passthrough(value) { return String(value || ''); };

  function buildInlineStyle(textColor, backgroundColor) {
    var style = {};
    if (textColor) style.color = textColor;
    if (backgroundColor) style['background-color'] = backgroundColor;
    var keys = Object.keys(style);
    if (!keys.length) return '';
    return keys.map(function (key) { return key + ':' + style[key] + ';'; }).join('');
  }

  function wrapInlineHtml(segment, opts) {
    if (opts.inlineStyle) segment = '<span style="' + escapeAttr(opts.inlineStyle) + '">' + segment + '</span>';
    if (opts.isInlineCode) segment = '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;padding:0.1em 0.3em;border-radius:4px;">' + segment + '</code>';
    if (opts.isBold) segment = '<strong>' + segment + '</strong>';
    if (opts.isItalic) segment = '<em>' + segment + '</em>';
    if (opts.isStrike) segment = '<del>' + segment + '</del>';
    if (opts.linkHref) segment = '<a href="' + escapeAttr(opts.linkHref) + '">' + segment + '</a>';
    return segment;
  }

  while (i < attribsStr.length) {
    var attrs = [];
    while (i < attribsStr.length && attribsStr[i] === '*') {
      i++;
      var numStr = '';
      while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
        numStr += attribsStr[i];
        i++;
      }
      var num = parseInt(numStr, 36);
      if (numToAttrib[num]) attrs.push(numToAttrib[num]);
    }

    if (i < attribsStr.length && attribsStr[i] === '+') {
      i++;
      var countStr = '';
      while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
        countStr += attribsStr[i];
        i++;
      }
      var count = parseInt(countStr, 36);

      var equationAttr = null;
      var linkAttr = null;
      var isBold = false;
      var isItalic = false;
      var isStrike = false;
      var isInlineCode = false;
      var textColor = '';
      var backgroundColor = '';

      for (var ai = 0; ai < attrs.length; ai++) {
        var a = attrs[ai];
        if (a[0] === 'equation') equationAttr = a;
        else if (a[0] === 'link') linkAttr = a;
        else if (a[0] === 'bold' && a[1] === 'true') isBold = true;
        else if (a[0] === 'italic' && a[1] === 'true') isItalic = true;
        else if (a[0] === 'strikethrough' && a[1] === 'true') isStrike = true;
        else if (a[0] === 'inlineCode' && a[1] === 'true') isInlineCode = true;
        else if (a[0] === 'textHighlight') textColor = normalizeColor(a[1]);
        else if (a[0] === 'textHighlightBackground') backgroundColor = normalizeColor(a[1]);
      }

      var rawText = textStr.substring(textIdx, textIdx + count);

      if (equationAttr) {
        // Keep LaTeX as a raw text node so Feishu can re-parse it during
        // HTML paste, especially inside list items where wrapped spans tend
        // to stay literal.
        result.push(escapeHtml('$' + normalizeEquationLatex(equationAttr[1]) + '$'));
      } else {
        var segment = escapeHtml(rawText).replace(/\n/g, '<br>');
        segment = wrapInlineHtml(segment, {
          isInlineCode: isInlineCode,
          isBold: isBold,
          isItalic: isItalic,
          isStrike: isStrike,
          linkHref: linkAttr ? decodeURIComponent(linkAttr[1] || '') : '',
          inlineStyle: buildInlineStyle(textColor, backgroundColor),
        });
        result.push(segment);
      }

      textIdx += count;
    } else {
      break;
    }
  }

  if (textIdx < textStr.length) {
    result.push(escapeHtml(textStr.substring(textIdx)).replace(/\n/g, '<br>'));
  }

  return normalizeLatexHtmlTextNodes(result.join(''));
}

function normalizeLatexHtmlTextNodes(html) {
  return String(html || '')
    .split(/(<[^>]+>)/g)
    .map(function (part) {
      return part && part[0] === '<' ? part : normalizeLatexForHtml(part);
    })
    .join('');
}

function decodeBlockText(snap) {
  if (!snap || !snap.text || !snap.text.initialAttributedTexts || !snap.text.apool) return '';
  var iat = snap.text.initialAttributedTexts;
  var apool = snap.text.apool;
  var attribs = (iat.attribs && iat.attribs['0']) || '';
  var text = (iat.text && iat.text['0']) || '';
  var numToAttrib = apool.numToAttrib || {};
  return decodeFeishuAttribs(attribs, text, numToAttrib);
}

function decodeBlockHtml(snap, options) {
  if (!snap || !snap.text || !snap.text.initialAttributedTexts || !snap.text.apool) {
    return escapeHtml(decodeBlockText(snap));
  }
  var iat = snap.text.initialAttributedTexts;
  var apool = snap.text.apool;
  var attribs = (iat.attribs && iat.attribs['0']) || '';
  var text = (iat.text && iat.text['0']) || '';
  var numToAttrib = apool.numToAttrib || {};
  return decodeFeishuAttribsToHtml(attribs, text, numToAttrib, options);
}

module.exports = {
  containsLatexText: containsLatexText,
  decodeBlockHtml: decodeBlockHtml,
  decodeBlockText: decodeBlockText,
  decodeFeishuAttribs: decodeFeishuAttribs,
  decodeFeishuAttribsToHtml: decodeFeishuAttribsToHtml,
  escapeAttr: escapeAttr,
  escapeHtml: escapeHtml,
  findNextNonWhitespaceChar: findNextNonWhitespaceChar,
  isFormulaBoundaryWordChar: isFormulaBoundaryWordChar,
  normalizeEquationLatex: normalizeEquationLatex,
  normalizeLatexForHtml: normalizeLatexForHtml,
  normalizeLatexHtmlTextNodes: normalizeLatexHtmlTextNodes,
  normalizeLatexTextBoundaries: normalizeLatexTextBoundaries,
  normalizePlainText: normalizePlainText,
  splitLatexSegments: splitLatexSegments,
};
