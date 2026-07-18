'use strict';

var SAFE_STYLE_PROPERTIES = {
  background: true, 'background-color': true, border: true, 'border-collapse': true,
  'border-color': true, 'border-left': true, 'border-radius': true, 'border-top': true,
  color: true, display: true, flex: true, 'font-family': true, 'font-size': true,
  gap: true, height: true, 'line-height': true, margin: true, 'margin-top': true,
  'max-width': true, overflow: true, padding: true, 'padding-left': true,
  'text-align': true, 'text-indent': true, 'vertical-align': true,
  'white-space': true, width: true,
};

function sanitizeUrlAttribute(value, kind) {
  var url = String(value || '').replace(/[\u0000-\u001f\u007f\s]+/g, '').trim();
  if (!url) return '';
  if (kind === 'image') {
    if (/^https:\/\//i.test(url)) return url;
    if (/^\/(?!\/)/.test(url)) return url;
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url) && url.length <= 28 * 1024 * 1024) {
      return url;
    }
    return '';
  }
  if (url[0] === '#' || /^\/(?!\/)/.test(url)) return url;
  return /^(?:https?:\/\/|mailto:)/i.test(url) ? url : '';
}

function sanitizeStyleAttribute(value) {
  return String(value || '').split(';').map(function (declaration) {
    var separator = declaration.indexOf(':');
    if (separator <= 0) return '';
    var property = declaration.slice(0, separator).trim().toLowerCase();
    var propertyValue = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES[property] || !propertyValue || propertyValue.length > 256) return '';
    if (/[\\{}<>]|url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding/i.test(propertyValue)) return '';
    return property + ':' + propertyValue + ';';
  }).filter(Boolean).join('');
}

// HTML sanitizer + post-processing helpers used by the userscript bundle.
// Functions in this module rely on browser globals (document, DOMParser,
// NodeFilter); they're not directly callable from Node, but they live here so
// the userscript bundle can import them and so other lib modules can compose
// against the shared allowlists.
//
// `latex` arg is the lib/feishu-attribs module re-exported helpers we depend
// on:
//   - normalizeLatexHtmlTextNodes
//   - normalizeLatexForHtml
// Pass them via the factory so this module never reaches outside its package.

function createHtmlSanitizer(deps) {
  var normalizeLatexHtmlTextNodes = deps.normalizeLatexHtmlTextNodes;
  var normalizeLatexForHtml = deps.normalizeLatexForHtml;
  var containsLatexText = deps.containsLatexText;
  var escapeAttr = deps.escapeAttr;

  var BLOCKED_TAGS = {
    SCRIPT: true, STYLE: true, META: true, LINK: true, IFRAME: true,
    OBJECT: true, EMBED: true, FORM: true, INPUT: true, BUTTON: true,
    TEXTAREA: true, SELECT: true, OPTION: true, SVG: true, CANVAS: true,
    NOSCRIPT: true,
  };
  var ALLOWED_TAGS = {
    A: true, BLOCKQUOTE: true, BR: true, CODE: true, DEL: true, DIV: true,
    EM: true, FIGCAPTION: true, FIGURE: true, H1: true, H2: true, H3: true,
    H4: true, H5: true, H6: true, HR: true, IMG: true, LI: true, OL: true,
    P: true, PRE: true, STRONG: true, TABLE: true, TBODY: true, TD: true,
    TH: true, THEAD: true, TR: true, UL: true, SPAN: true,
  };
  var TEXT_SENSITIVE_TAGS = { CODE: true, PRE: true };
  var ATTR_ALLOWLIST = {
    A: { href: true, style: true },
    BLOCKQUOTE: { style: true },
    CODE: { style: true },
    DEL: { style: true },
    DIV: { style: true },
    EM: { style: true },
    FIGCAPTION: { style: true },
    FIGURE: { style: true },
    H1: { style: true }, H2: { style: true }, H3: { style: true },
    H4: { style: true }, H5: { style: true }, H6: { style: true },
    HR: { style: true },
    IMG: { src: true, alt: true, style: true },
    LI: { style: true },
    OL: { style: true },
    P: { style: true },
    PRE: { style: true },
    STRONG: { style: true },
    TABLE: { style: true, border: true, cellpadding: true, cellspacing: true },
    TBODY: {},
    TD: { style: true, colspan: true, rowspan: true },
    TH: { style: true, colspan: true, rowspan: true },
    THEAD: {},
    TR: { style: true },
    UL: { style: true },
    SPAN: { style: true },
  };
  var INLINE_LIST_TAGS = {
    A: true, BR: true, CODE: true, DEL: true, EM: true, IMG: true,
    SPAN: true, STRONG: true,
  };
  var PRESERVED_DATA_ATTRS = {
    'data-block-type': true,
    'data-block-id': true,
    'data-record-id': true,
    'data-feishu-downgraded-images': true,
    'data-emoji-id': true,
    'data-lark-record-data': true,
    'data-lark-record-format': true,
    'data-meta-block-props': true,
    'data-page-id': true,
    'data-lark-html-role': true,
    'data-docx-has-block-data': true,
  };

  function shouldPreserveFeishuHtmlAttribute(el, attr) {
    if (!el || !attr) return false;
    var name = String(attr.name || '').toLowerCase();
    if (!name) return false;

    if (name === 'class') {
      if (el.hasAttribute('data-block-type')) return true;
      return /\b(docx-[\w-]+|callout-[\w-]+|lark-record-clipboard|zoneType-[\w-]+)\b/i.test(String(attr.value || ''));
    }

    return !!PRESERVED_DATA_ATTRS[name];
  }

  function isImageBlockElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'FIGURE') return !!el.querySelector('img');
    if ((el.tagName === 'P' || el.tagName === 'DIV') && el.querySelector('img')) {
      var meaningfulText = (el.textContent || '').replace(/\s+/g, '');
      return meaningfulText === '';
    }
    return false;
  }

  function isFormulaBearingBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!/^(P|DIV|UL|OL|BLOCKQUOTE|TABLE)$/.test(el.tagName)) return false;
    return containsLatexText(el.textContent || '');
  }

  function isolateFormulaBlocksAfterImages(root) {
    function walk(parent) {
      var children = Array.from(parent.children || []);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (!child || child.nodeType !== 1) continue;
        walk(child);
      }

      children = Array.from(parent.children || []);
      for (var j = 1; j < children.length; j++) {
        var prev = children[j - 1];
        var current = children[j];
        if (!isImageBlockElement(prev) || !isFormulaBearingBlock(current)) continue;
        if (current.tagName === 'DIV' && current.getAttribute('style') === 'display:block;') continue;

        var wrapper = document.createElement('div');
        wrapper.setAttribute('style', 'display:block;');
        parent.insertBefore(wrapper, current);
        wrapper.appendChild(current);
        children = Array.from(parent.children || []);
      }
    }

    walk(root);
  }

  function sanitizeHtmlFragment(html) {
    var prepared = normalizeLatexHtmlTextNodes((html || '').trim());
    if (!prepared) return '';

    var container = document.createElement('div');
    container.innerHTML = prepared;

    Array.from(container.querySelectorAll('*')).forEach(function (el) {
      if (BLOCKED_TAGS[el.tagName]) {
        el.remove();
        return;
      }

      if (!ALLOWED_TAGS[el.tagName]) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
        return;
      }

      Array.from(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        if (shouldPreserveFeishuHtmlAttribute(el, attr)) return;
        if (name.indexOf('data-') === 0 || name === 'id' || name === 'class' || name === 'contenteditable' || name === 'role') {
          el.removeAttribute(attr.name);
          return;
        }
        var allowed = ATTR_ALLOWLIST[el.tagName] || {};
        if (!allowed[name]) {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'href') {
          var safeHref = sanitizeUrlAttribute(attr.value, 'link');
          if (safeHref) el.setAttribute(attr.name, safeHref);
          else el.removeAttribute(attr.name);
        } else if (name === 'src') {
          var safeSrc = sanitizeUrlAttribute(attr.value, 'image');
          if (safeSrc) el.setAttribute(attr.name, safeSrc);
          else el.removeAttribute(attr.name);
        } else if (name === 'style') {
          var safeStyle = sanitizeStyleAttribute(attr.value);
          if (safeStyle) el.setAttribute(attr.name, safeStyle);
          else el.removeAttribute(attr.name);
        }
      });

      if (el.tagName === 'A' && !el.getAttribute('href')) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
        return;
      }

      if (el.tagName === 'IMG' && !el.getAttribute('src')) {
        el.remove();
      }
    });

    var commentWalker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT, null);
    var commentNodes = [];
    while (commentWalker.nextNode()) commentNodes.push(commentWalker.currentNode);
    commentNodes.forEach(function (node) { node.remove(); });

    var textWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    while (textWalker.nextNode()) textNodes.push(textWalker.currentNode);
    textNodes.forEach(function (node) {
      var parentTag = node.parentNode && node.parentNode.tagName;
      if (parentTag && TEXT_SENSITIVE_TAGS[parentTag]) return;
      node.textContent = normalizeLatexForHtml(node.textContent);
    });

    Array.from(container.querySelectorAll('li')).forEach(function (li) {
      var nodesToWrap = [];
      var blockedByStructure = false;

      Array.from(li.childNodes).forEach(function (node) {
        if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) return;
        if (node.nodeType === 3) {
          if (node.textContent && node.textContent.trim()) nodesToWrap.push(node);
          return;
        }
        if (node.nodeType === 1 && node.tagName === 'P') {
          nodesToWrap.push(node);
          return;
        }
        if (node.nodeType === 1 && INLINE_LIST_TAGS[node.tagName]) {
          nodesToWrap.push(node);
          return;
        }
        if (node.nodeType === 1) blockedByStructure = true;
      });

      if (!nodesToWrap.length || blockedByStructure) return;
      if (nodesToWrap.length === 1 && nodesToWrap[0].nodeType === 1 && nodesToWrap[0].tagName === 'P') {
        if (!nodesToWrap[0].getAttribute('style')) nodesToWrap[0].setAttribute('style', 'margin:0;');
        return;
      }

      var p = document.createElement('p');
      p.setAttribute('style', 'margin:0;');
      li.insertBefore(p, nodesToWrap[0]);
      nodesToWrap.forEach(function (node) { p.appendChild(node); });
    });

    Array.from(container.querySelectorAll('span')).forEach(function (el) {
      if (el.attributes.length === 0) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
      }
    });

    Array.from(container.querySelectorAll('p,div,li,blockquote,figcaption')).forEach(function (el) {
      if (!el.querySelector('img,br,table,ul,ol,pre,code,figure,blockquote') && !el.textContent.trim()) {
        el.remove();
      }
    });

    isolateFormulaBlocksAfterImages(container);

    container.normalize();
    return container.innerHTML.trim();
  }

  function normalizeListHtmlFragment(html) {
    if (!html || html.indexOf('data-feishu-list=') === -1) return html;

    var container = document.createElement('div');
    container.innerHTML = html;

    function groupListChildren(node) {
      Array.from(node.children).forEach(function (child) {
        groupListChildren(child);
      });

      var index = 0;
      while (index < node.children.length) {
        var child = node.children[index];
        if (!child || child.tagName !== 'LI' || !child.hasAttribute('data-feishu-list')) {
          index++;
          continue;
        }

        var kind = child.getAttribute('data-feishu-list');
        var wrapper = document.createElement(kind === 'ordered' ? 'ol' : 'ul');
        wrapper.style.cssText = 'margin:0.75em 0;padding-left:1.6em;';
        node.insertBefore(wrapper, child);

        while (child && child.tagName === 'LI' && child.getAttribute('data-feishu-list') === kind) {
          var next = child.nextElementSibling;
          child.removeAttribute('data-feishu-list');
          wrapper.appendChild(child);
          child = next;
        }

        index++;
      }
    }

    groupListChildren(container);
    return container.innerHTML;
  }

  function finalizeHtmlFragment(html) {
    return sanitizeHtmlFragment(normalizeListHtmlFragment((html || '').trim()));
  }

  function extractPlainTextFromHtmlFragment(html) {
    var trimmed = String(html || '').trim();
    if (!trimmed) return '';
    try {
      var doc = new DOMParser().parseFromString('<body>' + trimmed + '</body>', 'text/html');
      return (doc && doc.body ? (doc.body.textContent || '') : '');
    } catch (err) {
      return '';
    }
  }

  function buildClipboardHtml(bodyHtml, hasDowngradedImages) {
    // When images have been downgraded to base64 the docx/record no longer
    // contains image blocks.  Feishu's paste handler prefers docx/record over
    // HTML, so leaving data-docx-has-block-data="true" silently drops the
    // base64 <img> tags.  Setting the flag to "false" forces Feishu to walk
    // the HTML paste path, which can convert base64 <img> back into image
    // blocks via the text/html handler.
    var fragment = finalizeHtmlFragment(bodyHtml);
    var blockDataFlag = hasDowngradedImages ? 'false' : 'true';
    var rootAttr = ' data-page-id="" data-lark-html-role="root" data-docx-has-block-data="' + blockDataFlag + '"';
    return '<meta charset="utf-8"><div' + rootAttr + '>' + fragment + '</div>';
  }

  function sanitizeClipboardHtml(html) {
    var container = document.createElement('div');
    container.innerHTML = String(html || '');
    var root = container.querySelector('[data-lark-html-role="root"]');
    var hasDowngradedImages = !!(root && root.getAttribute('data-docx-has-block-data') === 'false')
      || /data-feishu-downgraded-images="true"/i.test(String(html || ''));
    return buildClipboardHtml(root ? root.innerHTML : container.innerHTML, hasDowngradedImages);
  }

  return {
    buildClipboardHtml: buildClipboardHtml,
    extractPlainTextFromHtmlFragment: extractPlainTextFromHtmlFragment,
    finalizeHtmlFragment: finalizeHtmlFragment,
    isFormulaBearingBlock: isFormulaBearingBlock,
    isImageBlockElement: isImageBlockElement,
    isolateFormulaBlocksAfterImages: isolateFormulaBlocksAfterImages,
    normalizeListHtmlFragment: normalizeListHtmlFragment,
    sanitizeClipboardHtml: sanitizeClipboardHtml,
    sanitizeHtmlFragment: sanitizeHtmlFragment,
    shouldPreserveFeishuHtmlAttribute: shouldPreserveFeishuHtmlAttribute,
  };
}

module.exports = {
  createHtmlSanitizer: createHtmlSanitizer,
  sanitizeStyleAttribute: sanitizeStyleAttribute,
  sanitizeUrlAttribute: sanitizeUrlAttribute,
};
