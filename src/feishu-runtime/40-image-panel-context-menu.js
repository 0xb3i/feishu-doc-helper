  // ── Image extraction panel (Cmd+Shift+I) ───────────────────────────────────

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

  function extractUrlFromBackgroundImage(backgroundImage) {
    if (!backgroundImage) return '';
    var urlIndex = backgroundImage.indexOf('url(');
    if (urlIndex === -1) return '';
    var remainder = backgroundImage.slice(urlIndex + 4).trim();
    if (!remainder) return '';
    var quote = remainder[0];
    if (quote === '"' || quote === '\'') {
      var quotedEnd = remainder.indexOf(quote, 1);
      return quotedEnd > 0 ? remainder.slice(1, quotedEnd) : '';
    }
    var closeIndex = remainder.indexOf(')');
    return closeIndex > -1 ? remainder.slice(0, closeIndex).trim() : '';
  }

  function extractDomImages() {
    var images = [];
    var seen = new Set();
    document.querySelectorAll('img').forEach(function (img) {
      var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (src && !seen.has(src)) {
        seen.add(src);
        images.push({
          src: src,
          alt: img.alt || '',
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      }
    });
    document.querySelectorAll('[style*="background-image"]').forEach(function (el) {
      var bgUrl = extractUrlFromBackgroundImage(el.style.backgroundImage || '');
      if (bgUrl && !seen.has(bgUrl)) {
        seen.add(bgUrl);
        images.push({
          src: bgUrl,
          alt: '',
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      }
    });
    return images;
  }

  function extractImages() {
    var content = null;
    try { content = extractFullDoc(); } catch (error) {}
    var modelImages = content ? buildImageEntriesFromDocxRecord(content.docxRecord) : [];
    return modelImages.length ? modelImages : extractDomImages();
  }

  function ensureImagePanelStyles() {
    if (document.getElementById('__feishu_image_panel_styles__')) return;
    var style = document.createElement('style');
    style.id = '__feishu_image_panel_styles__';
    style.textContent = [
      '.feishu-imgx__mask{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,0.45);font-family:"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '-webkit-font-smoothing:antialiased;}',
      '.feishu-imgx__dialog{display:flex;flex-direction:column;background:#fff;border-radius:8px;',
      'box-shadow:0 6px 16px 0 rgba(0,0,0,0.08),0 3px 6px -4px rgba(0,0,0,0.12),0 9px 28px 8px rgba(0,0,0,0.05);',
      'max-width:min(880px,86vw);max-height:82vh;width:100%;overflow:hidden;}',
      '.feishu-imgx__head{display:flex;justify-content:space-between;align-items:center;gap:16px;',
      'padding:16px 24px;border-bottom:1px solid #f0f0f0;flex:0 0 auto;}',
      '.feishu-imgx__title{margin:0;font-size:16px;font-weight:600;color:rgba(0,0,0,0.88);line-height:1.5;}',
      '.feishu-imgx__actions{display:flex;gap:8px;flex:0 0 auto;}',
      '.feishu-imgx__btn{height:32px;padding:0 15px;border-radius:6px;font-size:14px;line-height:30px;',
      'cursor:pointer;border:1px solid transparent;transition:all .2s cubic-bezier(.645,.045,.355,1);white-space:nowrap;}',
      '.feishu-imgx__btn--primary{background:#1677ff;color:#fff;border-color:#1677ff;}',
      '.feishu-imgx__btn--primary:hover{background:#4096ff;border-color:#4096ff;}',
      '.feishu-imgx__btn--primary:active{background:#0958d9;border-color:#0958d9;}',
      '.feishu-imgx__btn--default{background:#fff;color:rgba(0,0,0,0.88);border-color:#d9d9d9;}',
      '.feishu-imgx__btn--default:hover{color:#4096ff;border-color:#4096ff;}',
      '.feishu-imgx__btn--default:active{color:#0958d9;border-color:#0958d9;}',
      '.feishu-imgx__body{padding:20px 24px;overflow:auto;flex:1 1 auto;}',
      '.feishu-imgx__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:12px;}',
      '.feishu-imgx__card{display:flex;flex-direction:column;align-items:center;border:1px solid #f0f0f0;',
      'border-radius:8px;padding:12px;background:#fff;transition:box-shadow .2s ease,border-color .2s ease;}',
      '.feishu-imgx__card:hover{border-color:transparent;box-shadow:0 1px 2px -2px rgba(0,0,0,0.16),',
      '0 3px 6px 0 rgba(0,0,0,0.12),0 5px 12px 4px rgba(0,0,0,0.09);}',
      '.feishu-imgx__thumb{width:100%;height:150px;object-fit:contain;border-radius:4px;background:#fafafa;}',
      '.feishu-imgx__meta{margin-top:8px;font-size:12px;color:rgba(0,0,0,0.45);font-variant-numeric:tabular-nums;}',
      '.feishu-imgx__link{margin-top:4px;font-size:13px;color:#1677ff;text-decoration:none;transition:color .2s ease;}',
      '.feishu-imgx__link:hover{color:#4096ff;}',
    ].join('');
    document.head.appendChild(style);
  }

  function createImagePanel(images) {
    var existing = document.getElementById('__feishu_image_panel__');
    if (existing) existing.remove();
    ensureImagePanelStyles();

    var panel = document.createElement('div');
    panel.id = '__feishu_image_panel__';
    panel.className = 'feishu-imgx__mask';
    panel.innerHTML =
      '<div class="feishu-imgx__dialog" role="dialog" aria-modal="true" aria-label="图片提取">'
      + '<div class="feishu-imgx__head">'
      + '<h3 class="feishu-imgx__title">图片提取 (' + images.length + ' 张)</h3>'
      + '<div class="feishu-imgx__actions">'
      + '<button id="__feishu_download_all__" class="feishu-imgx__btn feishu-imgx__btn--primary" type="button">全部下载</button>'
      + '<button id="__feishu_close_panel__" class="feishu-imgx__btn feishu-imgx__btn--default" type="button">关闭</button>'
      + '</div>'
      + '</div>'
      + '<div class="feishu-imgx__body">'
      + '<div class="feishu-imgx__grid">'
      + images.map(function (img, i) {
          return '<div class="feishu-imgx__card">'
            + '<img class="feishu-imgx__thumb" src="' + img.src + '" crossorigin="anonymous" alt="图片 ' + (i + 1) + '">'
            + '<div class="feishu-imgx__meta">' + img.width + ' x ' + img.height + '</div>'
            + '<a class="feishu-imgx__link" href="' + img.src + '" target="_blank" download="feishu_img_' + (i + 1) + '.png">下载</a>'
            + '</div>';
        }).join('')
      + '</div></div></div>';

    document.body.appendChild(panel);

    function closePanel() {
      panel.remove();
      document.removeEventListener('keydown', onKeydown, true);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') closePanel();
    }

    document.getElementById('__feishu_close_panel__').onclick = closePanel;
    document.getElementById('__feishu_download_all__').onclick = function () {
      images.forEach(function (img, i) {
        setTimeout(function () {
          var a = document.createElement('a');
          a.href = img.src;
          a.target = '_blank';
          a.download = 'feishu_img_' + (i + 1) + '.png';
          a.click();
        }, i * 300);
      });
    };
    panel.addEventListener('click', function (e) {
      if (e.target === panel) closePanel();
    });
    document.addEventListener('keydown', onKeydown, true);
  }

  // ── Right-click "复制图片" injected into the Feishu context menu ────────────

  function getImageInfoFromTarget(target) {
    if (!target || !target.closest) return null;

    // 1) 直接命中 <img>。
    var img = target.closest('img');
    // 2) 飞书图片块常在 <img> 上盖了一层遮罩/交互 div，右击时 e.target 是那层遮罩，
    //    此时向上找到图片块容器，再从里面取真正的 <img>。
    if (!img) {
      var block = target.closest(
        '[data-block-type="image"], [data-page-block-type="image"], '
        + '.block-image, .image-block, [class*="ImageBlock"], [class*="image-block"], '
        + '[class*="image-content"], [class*="ImgContainer"], [class*="img-container"], '
        + '[class*="image-wrap"], [class*="imageWrap"]'
      );
      if (block) img = block.querySelector('img');
    }
    if (img) {
      var src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (!src) return null;
      return {
        src: src,
        alt: img.alt || '',
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        element: img,
        sourceType: 'img',
      };
    }

    // 3) 背景图（含祖先节点上的 background-image）。
    var el = target;
    var bgUrl = '';
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1) {
        var bg = getComputedStyle(el).backgroundImage || '';
        bgUrl = extractUrlFromBackgroundImage(bg);
        if (bgUrl) break;
      }
      el = el.parentElement;
    }
    if (!el || !bgUrl) return null;
    return {
      src: bgUrl,
      alt: '',
      width: el.offsetWidth || 0,
      height: el.offsetHeight || 0,
      element: el,
      sourceType: 'background',
    };
  }

  // 把已经在页面里渲染好的图片像素写入剪贴板。飞书的下载接口
  // (/space/api/box/stream/download/...) 受"复制保护"限制，直接 fetch 会被拒绝，
  // 所以优先走浏览器里已解码的像素（canvas / data / blob），完全绕开该接口。
  function writeBlobToClipboard(blob) {
    if (!navigator.clipboard || !navigator.clipboard.write) {
      return Promise.reject(new Error('clipboard unavailable'));
    }
    // ClipboardItem 仅稳定支持 png，必要时先转码成 png。
    return ensurePngBlob(blob).then(function (pngBlob) {
      var item = {};
      item['image/png'] = pngBlob;
      return navigator.clipboard.write([new ClipboardItem(item)]);
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      try {
        if (canvas.toBlob) {
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('toBlob returned null'));
          }, 'image/png');
        } else {
          var dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrlToBlob(dataUrl));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(',');
    var mimeMatch = parts[0].match(/data:([^;]+)/);
    var mime = mimeMatch ? mimeMatch[1] : 'image/png';
    var binary = atob(parts[1] || '');
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function ensurePngBlob(blob) {
    if (blob && blob.type === 'image/png') return Promise.resolve(blob);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          canvasToBlob(canvas).then(resolve).catch(reject);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // 从一个已解码的 <img> 元素抓像素（不发任何网络请求）。跨域未开启 CORS 时
  // canvas 会被污染，toBlob 抛 SecurityError，交由上层回退。
  function blobFromLiveImageElement(imgEl) {
    return new Promise(function (resolve, reject) {
      try {
        if (!imgEl || !(imgEl.naturalWidth || imgEl.width)) {
          reject(new Error('image not ready'));
          return;
        }
        var canvas = document.createElement('canvas');
        canvas.width = imgEl.naturalWidth || imgEl.width;
        canvas.height = imgEl.naturalHeight || imgEl.height;
        canvas.getContext('2d').drawImage(imgEl, 0, 0, canvas.width, canvas.height);
        canvasToBlob(canvas).then(resolve).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  // 用 crossOrigin=anonymous 重新加载同一 URL，若 CDN 返回 CORS 头即可取到干净像素。
  function blobFromCorsReload(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        blobFromLiveImageElement(img).then(resolve).catch(reject);
      };
      img.onerror = function () { reject(new Error('cors reload failed')); };
      img.src = url;
    });
  }

  // 通过内容脚本 → 后台 service worker 跨域抓取图片字节（不受页面 CORS 限制，
  // 等效于浏览器原生"复制图片"的取数能力），返回 data URL。
  function fetchImageViaBackground(url) {
    return new Promise(function (resolve, reject) {
      var requestId = 'imgfetch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var timer = setTimeout(function () {
        document.removeEventListener('feishu-helper:image-fetch-result', onResult, true);
        reject(new Error('background image fetch timeout'));
      }, 20000);
      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener('feishu-helper:image-fetch-result', onResult, true);
        if (detail.ok && detail.dataUrl) resolve(detail.dataUrl);
        else reject(new Error(detail.error || 'background image fetch failed'));
      }
      document.addEventListener('feishu-helper:image-fetch-result', onResult, true);
      document.dispatchEvent(new CustomEvent('feishu-helper:image-fetch', {
        detail: { requestId: requestId, url: url },
      }));
    });
  }

  function copyImageBlobToClipboard(imageInfo) {
    var url = imageInfo && imageInfo.src ? imageInfo.src : imageInfo;
    var element = imageInfo && imageInfo.element;

    // data:/blob: URL 直接读取，无需网络。
    if (/^(data:|blob:)/i.test(String(url))) {
      return originalFetch(url).then(function (res) { return res.blob(); }).then(writeBlobToClipboard);
    }

    var attempt = Promise.reject(new Error('start'));

    // 1) 首选：后台 service worker 跨域抓取（绕开 CORS，等效原生复制），
    //    拿到 data URL 后转 blob。这是最可靠、能真正拿到字节的路径。
    attempt = attempt.catch(function () {
      return fetchImageViaBackground(url).then(dataUrlToBlob);
    });
    // 2) 抓取页面里已渲染的 <img> 像素（同源或已带 CORS 时可用）。
    if (element && element.tagName === 'IMG') {
      attempt = attempt.catch(function () { return blobFromLiveImageElement(element); });
    }
    // 3) 带 CORS 重新加载同一 URL。
    attempt = attempt.catch(function () { return blobFromCorsReload(url); });
    // 4) 最后兜底：页面上下文原始 fetch（可能被复制保护/CORS 拒绝）。
    attempt = attempt.catch(function () {
      return originalFetch(url, { credentials: 'include' }).then(function (res) {
        if (!res.ok) throw new Error('fetch failed');
        return res.blob();
      });
    });

    return attempt.then(writeBlobToClipboard);
  }

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
      { key: 'open', label: '在新标签打开', handler: function () { window.open(imageInfo.src, '_blank'); } },
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
