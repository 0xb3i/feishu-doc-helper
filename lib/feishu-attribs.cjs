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

function safeDecodeURIComponent(value) {
  var input = String(value || '');
  try { return decodeURIComponent(input); }
  catch (error) { return input; }
}

function normalizeLinkHref(value) {
  var href = safeDecodeURIComponent(value)
    .replace(/[\u0000-\u001f\u007f\s]+/g, '')
    .trim();
  if (!href) return '';
  if (href[0] === '#' || (href[0] === '/' && href[1] !== '/')) return href;
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return href;
  return '';
}

function parseFeishuAttribRuns(attribsStr, textStr, numToAttrib) {
  var runs = [];
  var textIdx = 0;
  var i = 0;
  var stream = String(attribsStr || '');
  var text = String(textStr || '');
  var attribPool = numToAttrib || {};

  while (i < stream.length) {
    var attrs = [];
    while (i < stream.length && stream[i] === '*') {
      i++;
      var numStr = '';
      while (i < stream.length && /[0-9a-z]/.test(stream[i])) {
        numStr += stream[i];
        i++;
      }
      var num = parseInt(numStr, 36);
      if (attribPool[num]) attrs.push(attribPool[num]);
    }

    if (i >= stream.length || stream[i] !== '+') break;
    i++;
    var countStr = '';
    while (i < stream.length && /[0-9a-z]/.test(stream[i])) {
      countStr += stream[i];
      i++;
    }
    var count = parseInt(countStr, 36);
    var run = {
      rawText: text.substring(textIdx, textIdx + count),
      attrs: attrs,
      equationAttr: null,
      linkHref: '',
      isBold: false,
      isItalic: false,
      isStrike: false,
      isInlineCode: false,
      textColor: '',
      backgroundColor: '',
      hasTextColor: false,
      hasBackgroundColor: false,
      trailing: false,
    };

    for (var ai = 0; ai < attrs.length; ai++) {
      var attr = attrs[ai];
      if (attr[0] === 'equation') run.equationAttr = attr;
      else if (attr[0] === 'link') run.linkHref = normalizeLinkHref(attr[1] || '');
      else if (attr[0] === 'bold' && attr[1] === 'true') run.isBold = true;
      else if (attr[0] === 'italic' && attr[1] === 'true') run.isItalic = true;
      else if (attr[0] === 'strikethrough' && attr[1] === 'true') run.isStrike = true;
      else if (attr[0] === 'inlineCode' && attr[1] === 'true') run.isInlineCode = true;
      else if (attr[0] === 'textHighlight') {
        run.textColor = attr[1];
        run.hasTextColor = true;
      } else if (attr[0] === 'textHighlightBackground') {
        run.backgroundColor = attr[1];
        run.hasBackgroundColor = true;
      }
    }

    runs.push(run);
    textIdx += count;
  }

  if (textIdx < text.length) {
    runs.push({ rawText: text.substring(textIdx), trailing: true });
  }

  return runs;
}

// Read a single Feishu attrib stream (`*<num36>+<count36>...`) into a flat
// markdown string.  textStr supplies the raw text characters; numToAttrib maps
// attrib indices to `[name, value]` tuples produced by Feishu's apool.
function decodeFeishuAttribs(attribsStr, textStr, numToAttrib) {
  var result = [];
  parseFeishuAttribRuns(attribsStr, textStr, numToAttrib).forEach(function (run) {
    if (run.trailing) {
      result.push(run.rawText);
      return;
    }
    if (run.equationAttr) {
      result.push('$' + normalizeEquationLatex(run.equationAttr[1]) + '$');
      return;
    }
    var segment = run.rawText;
    if (run.isInlineCode) segment = '`' + segment + '`';
    if (run.isBold) segment = '**' + segment + '**';
    if (run.isItalic) segment = '*' + segment + '*';
    if (run.isStrike) segment = '~~' + segment + '~~';
    if (run.linkHref) segment = '[' + segment + '](' + run.linkHref + ')';
    result.push(segment);
  });

  return normalizeLatexTextBoundaries(result.join(''));
}

// HTML variant.  Accepts a `colorize` callback so the caller can plug in its
// own colour normaliser; defaults to passing values through unchanged.
function decodeFeishuAttribsToHtml(attribsStr, textStr, numToAttrib, options) {
  var result = [];
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

  parseFeishuAttribRuns(attribsStr, textStr, numToAttrib).forEach(function (run) {
    if (run.trailing) {
      result.push(escapeHtml(run.rawText).replace(/\n/g, '<br>'));
      return;
    }
    if (run.equationAttr) {
      // Keep LaTeX as a raw text node so Feishu can re-parse it during
      // HTML paste, especially inside list items where wrapped spans tend
      // to stay literal.
      result.push(escapeHtml('$' + normalizeEquationLatex(run.equationAttr[1]) + '$'));
      return;
    }
    var segment = escapeHtml(run.rawText).replace(/\n/g, '<br>');
    segment = wrapInlineHtml(segment, {
      isInlineCode: run.isInlineCode,
      isBold: run.isBold,
      isItalic: run.isItalic,
      isStrike: run.isStrike,
      linkHref: run.linkHref,
      inlineStyle: buildInlineStyle(
        run.hasTextColor ? normalizeColor(run.textColor) : '',
        run.hasBackgroundColor ? normalizeColor(run.backgroundColor) : ''
      ),
    });
    result.push(segment);
  });

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
  normalizeLinkHref: normalizeLinkHref,
  parseFeishuAttribRuns: parseFeishuAttribRuns,
  safeDecodeURIComponent: safeDecodeURIComponent,
  splitLatexSegments: splitLatexSegments,
};
