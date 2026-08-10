  // ── Page icon DOM adapter ──────────────────────────────────────────────────

  function normalizePageIconEmoji(value) {
    var clean = String(value || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .trim();
    if (!clean || /^(添加图标|Add icon)$/i.test(clean)) return '';
    return clean.length <= 24 ? clean : '';
  }

  function extractPageIconEmojiFromDom() {
    var selectors = [
      '.page-block-header__custom_icon .gpf-biz-suite-custom-icon__icon-emoji',
      '.page-block-header__custom_icon [class*="custom-icon__icon-emoji"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]), 0, 10);
      for (var j = 0; j < nodes.length; j++) {
        var emoji = normalizePageIconEmoji(nodes[j].innerText || nodes[j].textContent || '');
        if (emoji) return emoji;
      }
    }
    return '';
  }
  function isLikelyPageIconControl(node) {
    if (!node || node.nodeType !== 1) return false;
    var contentRoot = getContentRootElement();
    var pageHeader = node.closest && node.closest('.page-block-header');
    if (contentRoot && contentRoot.contains(node) && !pageHeader) return false;
    var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0, top: 9999 };
    if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.top > 260) return false;
    var haystack = [
      node.className,
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('title'),
      node.getAttribute && node.getAttribute('data-testid'),
      node.getAttribute && node.getAttribute('data-e2e'),
      node.innerText || node.textContent || '',
    ].join(' ');
    if (/添加封面|Add cover/i.test(haystack)) return false;
    var nodeText = normalizePasteTitle(node.innerText || node.textContent || '');
    var currentTitle = getCurrentDocumentTitleForPaste();
    if (currentTitle && nodeText.indexOf(currentTitle) !== -1 && !/添加图标|Add icon/i.test(haystack)) return false;
    return /custom[-_ ]?icon|添加图标|Add icon|page[-_ ]?icon|doc[-_ ]?custom[-_ ]?icon/i.test(haystack);
  }

  function dispatchPointerLikeEvents(node) {
    if (!node) return;
    ['pointerover', 'mouseover', 'mouseenter', 'mousemove'].forEach(function (type) {
      try { node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (err) {}
    });
  }

  function scrollPageHeaderIntoViewForIcon() {
    var header = document.querySelector('.page-block-header');
    if (!header) return;
    try { header.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) {}
    var node = header.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      try {
        if (node.scrollTop) node.scrollTop = 0;
      } catch (err) {}
      node = node.parentElement;
    }
    try { window.scrollTo(0, 0); } catch (err) {}
  }

  function revealPageIconControls() {
    scrollPageHeaderIntoViewForIcon();
    var nodes = [
      document.querySelector('.page-block-header'),
      document.querySelector('.page-block-header .page-block-content'),
      document.querySelector('.page-block-header-top'),
      document.querySelector('.zone-container.editor-kit-container'),
    ];
    nodes.forEach(function (node) {
      if (!node) return;
      dispatchPointerLikeEvents(node);
    });
  }

  function findPageIconPickerTrigger() {
    revealPageIconControls();
    var selectors = [
      '.page-block-header .custom-icon.gpf-biz-suite-custom-icon__icon-wrapper',
      '.page-block-header__custom_icon .custom-icon',
      '.page-block-header__custom_icon [class*="custom-icon"]',
      '.page-block-header [class*="custom-icon"]',
      '.page-block-header [class*="doc-custom-icon"]',
      '.page-block-header [class*="add-icon"]',
      '.page-block-header [class*="icon-add"]',
      '.page-block-header [aria-label*="添加图标"]',
      '.page-block-header [title*="添加图标"]',
      '.page-block-header [aria-label*="Add icon" i]',
      '.page-block-header [title*="Add icon" i]',
      '.page-block-header__custom_icon',
      '[aria-label*="添加图标"]',
      '[title*="添加图标"]',
      '[aria-label*="Add icon" i]',
      '[title*="Add icon" i]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]), 0, 30);
      for (var j = 0; j < nodes.length; j++) {
        if (isLikelyPageIconControl(nodes[j])) return nodes[j];
      }
    }
    var candidates = Array.prototype.slice.call(document.querySelectorAll('.page-block-header button, .page-block-header [role="button"], .page-block-header span, .page-block-header div, button, [role="button"]'), 0, 500);
    return candidates.find(isLikelyPageIconControl) || null;
  }

  function waitForPageIconPicker(timeoutMs) {
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      function tick() {
        var picker = document.querySelector('em-emoji-picker');
        if (picker) {
          resolve(picker);
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          resolve(null);
          return;
        }
        setTimeout(tick, 80);
      }
      tick();
    });
  }

  function waitForPageIconEmoji(emoji, timeoutMs) {
    var cleanEmoji = normalizePageIconEmoji(emoji);
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      function tick() {
        if (normalizePageIconEmoji(extractPageIconEmojiFromDom()) === cleanEmoji) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          resolve(false);
          return;
        }
        setTimeout(tick, 80);
      }
      tick();
    });
  }

  function findEmojiPickerEntry(picker, emoji) {
    var cleanEmoji = normalizePageIconEmoji(emoji);
    var emojis = picker && picker.props && picker.props.data && picker.props.data.emojis;
    if (!emojis || !cleanEmoji) return null;
    var keys = Object.keys(emojis);
    for (var i = 0; i < keys.length; i++) {
      var entry = emojis[keys[i]] || {};
      var skins = entry.skins || [];
      for (var j = 0; j < skins.length; j++) {
        if (normalizePageIconEmoji(skins[j] && skins[j].native) === cleanEmoji) {
          return { entry: entry, skin: skins[j] };
        }
      }
    }
    return null;
  }

  function selectPageIconEmojiFromPicker(picker, emoji) {
    var match = findEmojiPickerEntry(picker, emoji);
    var handler = picker && picker.props && picker.props.onEmojiSelect;
    if (!match || typeof handler !== 'function') return false;
    var selected = Object.assign({}, match.entry, match.skin, {
      native: match.skin.native,
      unified: match.skin.unified,
      shortcodes: match.skin.shortcodes,
    });
    try {
      handler(selected);
      return true;
    } catch (error) {
      try {
        handler(match.entry);
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  function openPageIconPicker() {
    var existingPicker = document.querySelector('em-emoji-picker');
    if (existingPicker) return Promise.resolve(existingPicker);
    var trigger = findPageIconPickerTrigger();
    if (!trigger) return Promise.resolve(null);
    try { trigger.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) {}
    try { trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window })); } catch (err) {}
    try { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', isPrimary: true })); } catch (err) {}
    try { trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: 1 })); } catch (err) {}
    try { trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', isPrimary: true })); } catch (err) {}
    try { trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, detail: 1 })); } catch (err) {}
    try { trigger.click(); } catch (err) {}
    return waitForPageIconPicker(1200);
  }

  function closePageIconPicker() {
    var picker = document.querySelector('em-emoji-picker');
    if (!picker) return false;
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch (err) {}
    try {
      var root = getContentRootElement() || document.body;
      root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', isPrimary: true }));
      root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: 1 }));
      root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', isPrimary: true }));
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, detail: 1 }));
      root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 }));
    } catch (err) {}
    return true;
  }

  function cleanupPageIconUi() {
    closePageIconPicker();
    closeHeaderTitleRenameInput();
  }

  function getCurrentBodyTextForPasteStability() {
    var root = getContentRootElement();
    return root ? attribs.normalizePlainText(root.innerText || root.textContent || '') : '';
  }

  function waitForPasteBodySettled(content, timeoutMs) {
    var expectedMinLen = Math.max(0, Math.min(String((content && content.text) || '').length - 80, 80));
    var startedAt = Date.now();
    var lastText = null;
    var stableSince = 0;
    return new Promise(function (resolve) {
      function tick() {
        var text = getCurrentBodyTextForPasteStability();
        var enoughContent = !expectedMinLen || text.length >= expectedMinLen;
        if (text === lastText) {
          if (!stableSince) stableSince = Date.now();
        } else {
          lastText = text;
          stableSince = 0;
        }
        if (enoughContent && stableSince && Date.now() - stableSince >= 900) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= Number(timeoutMs || 0)) {
          resolve(false);
          return;
        }
        setTimeout(tick, 180);
      }
      tick();
    });
  }

  function applyPageIconEmojiToCurrentDoc(emoji) {
    var cleanEmoji = normalizePageIconEmoji(emoji);
    if (!cleanEmoji) return Promise.resolve(false);
    if (normalizePageIconEmoji(extractPageIconEmojiFromDom()) === cleanEmoji) {
      cleanupPageIconUi();
      return Promise.resolve(true);
    }
    return openPageIconPicker().then(function (picker) {
      if (!picker || !selectPageIconEmojiFromPicker(picker, cleanEmoji)) {
        cleanupPageIconUi();
        return false;
      }
      return waitForPageIconEmoji(cleanEmoji, 1600).then(function (applied) {
        cleanupPageIconUi();
        return applied;
      });
    }).catch(function (error) {
      try { console.warn('[Feishu Helper] failed to apply page icon emoji', error); } catch (err) {}
      cleanupPageIconUi();
      return false;
    });
  }
