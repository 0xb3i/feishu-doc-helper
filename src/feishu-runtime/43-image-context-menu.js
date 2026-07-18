  // ── Our own floating context menu for images ───────────────────────────────
  // 飞书不会在图片上弹出原生菜单，所以右击图片时我们强制展示自建的飞书风格菜单，
  // 保证"复制图片 / 下载图片 / 在新标签打开"始终可用。

  function ensureImageContextMenuStyles() {
    if (document.getElementById('__feishu_image_ctxmenu_styles__')) return;
    var style = document.createElement('style');
    style.id = '__feishu_image_ctxmenu_styles__';
    style.textContent = [
      '.feishu-imgctx{position:fixed;z-index:2147483602;min-width:160px;padding:4px;background:#fff;',
      'border-radius:8px;border:1px solid rgba(0,0,0,0.06);',
      'box-shadow:0 6px 16px 0 rgba(0,0,0,0.08),0 3px 6px -4px rgba(0,0,0,0.12),0 9px 28px 8px rgba(0,0,0,0.05);',
      'font-family:"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '-webkit-font-smoothing:antialiased;}',
      '.feishu-imgctx__item{display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;',
      'border-radius:6px;font-size:14px;line-height:32px;color:rgba(0,0,0,0.88);cursor:pointer;',
      'user-select:none;transition:background .15s ease;white-space:nowrap;}',
      '.feishu-imgctx__item:hover{background:#f0f6ff;color:#1677ff;}',
      '.feishu-imgctx__icon{flex:0 0 16px;width:16px;height:16px;display:inline-flex;color:currentColor;}',
      '.feishu-imgctx__icon svg{width:16px;height:16px;}',
    ].join('');
    document.head.appendChild(style);
  }

  var CTX_ICONS = {
    copy: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M832 64H296c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h496v688c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8V96c0-17.7-14.3-32-32-32zM704 192H192c-17.7 0-32 14.3-32 32v530.7c0 8.5 3.4 16.6 9.4 22.6l173.3 173.3c2.2 2.2 4.7 4 7.4 5.5v1.9h4.2c3.5 1.3 7.2 2 11 2H704c17.7 0 32-14.3 32-32V224c0-17.7-14.3-32-32-32zM350 856.2L263.9 770H350v86.2zM664 888H414V746c0-22.1-17.9-40-40-40H232V264h432v624z"/></svg>',
    download: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M505.7 661a8 8 0 0 0 12.6 0l112-141.7c4.1-5.2.4-12.9-6.3-12.9h-74.1V168c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v338.3H400c-6.7 0-10.4 7.7-6.3 12.9l112 141.8zM878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8z"/></svg>',
    open: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M640 288H384c-4.4 0-8 3.6-8 8v48c0 4.4 3.6 8 8 8h164.7L286.3 614.7a8.03 8.03 0 0 0 0 11.3l33.9 33.9c3.1 3.1 8.2 3.1 11.3 0L594 397.3V560c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V304c0-8.8-7.2-16-16-16z"/><path d="M792 792H232V232h280c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8H192c-17.7 0-32 14.3-32 32v640c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V512c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v280z"/></svg>',
  };

  var imageContextMenuEl = null;

  function closeImageContextMenu() {
    if (imageContextMenuEl) {
      imageContextMenuEl.remove();
      imageContextMenuEl = null;
    }
    document.removeEventListener('mousedown', onImageContextMenuOutside, true);
    document.removeEventListener('scroll', closeImageContextMenu, true);
    window.removeEventListener('blur', closeImageContextMenu, true);
    document.removeEventListener('keydown', onImageContextMenuKeydown, true);
  }

  function onImageContextMenuOutside(e) {
    if (imageContextMenuEl && imageContextMenuEl.contains(e.target)) return;
    closeImageContextMenu();
  }

  function onImageContextMenuKeydown(e) {
    if (e.key === 'Escape') closeImageContextMenu();
  }

  function copyImageFromContext(imageInfo) {
    showImageMessage('loading', '正在复制图片…', 0);
    copyImageBlobToClipboard(imageInfo).then(function () {
      showImageMessage('success', '图片已复制到剪贴板', 2500);
    }).catch(function () {
      showImageMessage('error', '复制图片失败，可尝试"在新标签打开"', 3000);
    });
  }

  function downloadImageFromContext(imageInfo) {
    try {
      var a = document.createElement('a');
      a.href = imageInfo.src;
      a.download = 'feishu_image.png';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      showImageMessage('error', '下载图片失败', 2500);
    }
  }

  function openImageMenu(x, y, imageInfo) {
    ensureImageContextMenuStyles();
    closeImageContextMenu();

    var menu = document.createElement('div');
    menu.className = 'feishu-imgctx';
    menu.setAttribute('role', 'menu');

    var items = [
      { key: 'copy', label: '复制图片', handler: function () { copyImageFromContext(imageInfo); } },
      { key: 'download', label: '下载图片', handler: function () { downloadImageFromContext(imageInfo); } },
      { key: 'open', label: '在新标签打开', handler: function () {
        var opened = window.open(imageInfo.src, '_blank', 'noopener,noreferrer');
        if (opened) opened.opener = null;
      } },
    ];

    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'feishu-imgctx__item';
      el.setAttribute('role', 'menuitem');
      el.innerHTML = '<span class="feishu-imgctx__icon">' + (CTX_ICONS[it.key] || '') + '</span>'
        + '<span class="feishu-imgctx__label"></span>';
      el.querySelector('.feishu-imgctx__label').textContent = it.label;
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        closeImageContextMenu();
        it.handler();
      }, true);
      menu.appendChild(el);
    });

    document.body.appendChild(menu);

    var rect = menu.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = Math.max(8, Math.min(x, vw - rect.width - 8));
    var top = Math.max(8, Math.min(y, vh - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    imageContextMenuEl = menu;

    setTimeout(function () {
      document.addEventListener('mousedown', onImageContextMenuOutside, true);
      document.addEventListener('scroll', closeImageContextMenu, true);
      window.addEventListener('blur', closeImageContextMenu, true);
      document.addEventListener('keydown', onImageContextMenuKeydown, true);
    }, 0);
  }

  registerDisposer(closeImageContextMenu);

  // ── Event wiring ───────────────────────────────────────────────────────────
  // 右击图片：在 window 捕获阶段尽早拦截，阻断飞书自身的 contextmenu 处理
  // （否则会弹出"由于父级页面权限设置…"的权限提示），改用我们自己的菜单；
  // 右击其他区域不干预，让飞书原生菜单正常工作。

  // 右击点上可能盖着遮罩层，用 elementsFromPoint 逐层探测，找到第一个能识别出
  // 图片的元素（覆盖 e.target 命中遮罩、拿不到 <img> 的场景）。
  function resolveImageInfoAtPoint(e) {
    var info = getImageInfoFromTarget(e.target);
    if (info) return info;
    if (typeof document.elementsFromPoint !== 'function') return null;
    var stack = document.elementsFromPoint(e.clientX, e.clientY) || [];
    for (var i = 0; i < stack.length; i++) {
      info = getImageInfoFromTarget(stack[i]);
      if (info) return info;
    }
    return null;
  }

  // 飞书的"复制保护"提示并不是由 contextmenu 触发，而是挂在右键的
  // pointerdown/mousedown 上（button===2 时抢先弹提示）。因此仅拦 contextmenu
  // 不够，必须在 window 捕获阶段最早拦下右键按下类事件，命中图片时直接阻断，
  // 避免飞书处理器执行。
  function isRightButton(e) {
    return e.button === 2 || (e.buttons != null && e.buttons === 2);
  }

  function suppressFeishuRightButton(e) {
    if (!isRightButton(e)) return;
    if (!resolveImageInfoAtPoint(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
  }

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'].forEach(function (type) {
    registerEventListener(window, type, suppressFeishuRightButton, true);
  });

  registerEventListener(window, 'contextmenu', function (e) {
    var info = resolveImageInfoAtPoint(e);
    if (!info) {
      closeImageContextMenu();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    openImageMenu(e.clientX, e.clientY, info);
  }, true);

  registerEventListener(window, 'keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    var k = e.key.toLowerCase();
    if (k === 'd') {
      e.preventDefault();
      e.stopImmediatePropagation();
      duplicateDocumentForAutomation().catch(function () {});
    } else if (k === 'p') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pasteIntoDoc().catch(function () {});
    } else if (k === 'i') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var images = extractImages();
      if (!images.length) showImageMessage('error', '当前页面未找到图片', 2500);
      else createImagePanel(images);
    }
  }, true);
