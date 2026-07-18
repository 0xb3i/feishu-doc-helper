  // ── Single-image action feedback ───────────────────────────────────────────

  // Ant Design message 风格的页面内轻提示，用于右击"复制图片"等纯页面操作的反馈。
  function ensureImageMessageStyles() {
    if (document.getElementById('__feishu_image_message_styles__')) return;
    var style = document.createElement('style');
    style.id = '__feishu_image_message_styles__';
    style.textContent = [
      '.feishu-msg__wrap{position:fixed;top:16px;left:0;right:0;z-index:2147483601;display:flex;',
      'flex-direction:column;align-items:center;gap:8px;pointer-events:none;',
      'font-family:"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}',
      '.feishu-msg{display:inline-flex;align-items:center;gap:8px;max-width:80vw;padding:9px 12px;',
      'background:#fff;border-radius:8px;color:rgba(0,0,0,0.88);font-size:14px;line-height:1.5;',
      'box-shadow:0 6px 16px 0 rgba(0,0,0,0.08),0 3px 6px -4px rgba(0,0,0,0.12),0 9px 28px 8px rgba(0,0,0,0.05);',
      'pointer-events:auto;opacity:0;transform:translateY(-8px);transition:opacity .24s ease,transform .24s ease;}',
      '.feishu-msg--show{opacity:1;transform:translateY(0);}',
      '.feishu-msg__icon{flex:0 0 16px;width:16px;height:16px;display:inline-flex;}',
      '.feishu-msg__icon svg{width:16px;height:16px;}',
      '.feishu-msg--loading .feishu-msg__icon{color:#1677ff;animation:feishu-msg-spin 1s linear infinite;}',
      '.feishu-msg--success .feishu-msg__icon{color:#52c41a;}',
      '.feishu-msg--error .feishu-msg__icon{color:#ff4d4f;}',
      '@keyframes feishu-msg-spin{100%{transform:rotate(360deg);}}',
    ].join('');
    document.head.appendChild(style);
  }

  var MESSAGE_ICONS = {
    loading: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M988 548c-19.9 0-36-16.1-36-36 0-59.4-11.6-117-34.6-171.3a440.45 440.45 0 0 0-94.3-139.9 437.71 437.71 0 0 0-139.9-94.3C629 83.6 571.4 72 512 72c-19.9 0-36-16.1-36-36s16.1-36 36-36c69.1 0 136.2 13.5 199.3 40.3C772.3 66 827 103 874 150c47 47 83.9 101.8 109.7 162.7 26.7 63.1 40.2 130.2 40.2 199.3.1 19.9-16 36-35.9 36z"/></svg>',
    success: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm193.5 301.7l-210.6 292a31.8 31.8 0 0 1-51.7 0L318.5 484.9c-3.8-5.3 0-12.7 6.5-12.7h46.9c10.2 0 19.9 4.9 25.9 13.3l71.2 98.8 157.2-218c6-8.3 15.6-13.3 25.9-13.3H699c6.5 0 10.3 7.4 6.5 12.7z"/></svg>',
    error: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm165.4 618.2l-66-.3L512 563.4l-99.3 118.4-66.1.3c-4.4 0-8-3.5-8-8 0-1.9.7-3.7 1.9-5.2l130.1-155L340.5 359a8.32 8.32 0 0 1-1.9-5.2c0-4.4 3.6-8 8-8l66.1.3L512 464.6l99.3-118.4 66-.3c4.4 0 8 3.5 8 8 0 1.9-.7 3.7-1.9 5.2L553.5 514l130 155c1.2 1.5 1.9 3.3 1.9 5.2 0 4.4-3.6 8-8 8z"/></svg>',
  };

  var activeImageMessage = null;

  function showImageMessage(type, text, duration) {
    ensureImageMessageStyles();
    var wrap = document.getElementById('__feishu_image_message_wrap__');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = '__feishu_image_message_wrap__';
      wrap.className = 'feishu-msg__wrap';
      document.body.appendChild(wrap);
    }
    if (activeImageMessage) {
      if (activeImageMessage.timer) clearTimeout(activeImageMessage.timer);
      activeImageMessage.el.remove();
      activeImageMessage = null;
    }

    var el = document.createElement('div');
    el.className = 'feishu-msg feishu-msg--' + type;
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="feishu-msg__icon">' + (MESSAGE_ICONS[type] || MESSAGE_ICONS.loading) + '</span>'
      + '<span class="feishu-msg__text"></span>';
    el.querySelector('.feishu-msg__text').textContent = String(text == null ? '' : text);
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('feishu-msg--show'); });

    var record = { el: el, timer: 0 };
    activeImageMessage = record;

    function dismiss() {
      el.classList.remove('feishu-msg--show');
      setTimeout(function () {
        el.remove();
        if (activeImageMessage === record) activeImageMessage = null;
        if (wrap && !wrap.childElementCount) wrap.remove();
      }, 240);
    }

    if (duration !== 0) {
      record.timer = setTimeout(dismiss, duration || 2500);
    }
    return dismiss;
  }
