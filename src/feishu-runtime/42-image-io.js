  // ── DOM image discovery and clipboard IO ──────────────────────────────────

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

  // ── Right-click "复制图片" injected into the Feishu context menu ────────────

  function normalizeContextImageUrl(value) {
    var source = String(value || '').trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(source)) return source;
    try {
      var parsed = new URL(source, location.href);
      return /^(?:https?:|blob:)$/.test(parsed.protocol) ? parsed.href : '';
    } catch (error) {
      return '';
    }
  }

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
      var src = normalizeContextImageUrl(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original'));
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
    bgUrl = normalizeContextImageUrl(bgUrl);
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

  function requestTrustedImageAction(action, imageInfo) {
    var url = imageInfo && imageInfo.src ? imageInfo.src : imageInfo;
    return new Promise(function (resolve, reject) {
      var isDownload = action === 'download';
      var requestId = (isDownload ? 'imgdownload-' : 'imgcopy-')
        + Date.now() + '-' + Math.random().toString(16).slice(2);
      var requestEvent = isDownload
        ? 'feishu-helper:image-context-download'
        : 'feishu-helper:image-context-copy';
      var resultEvent = isDownload
        ? 'feishu-helper:image-context-download-result'
        : 'feishu-helper:image-context-copy-result';
      var timer = setTimeout(function () {
        document.removeEventListener(resultEvent, onResult, true);
        reject(new Error('image action bridge timeout'));
      }, 20000);
      function onResult(event) {
        var detail = (event && event.detail) || {};
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener(resultEvent, onResult, true);
        if (detail.ok && (detail.written || detail.downloaded)) resolve(detail);
        else reject(new Error(detail.error || 'image action failed'));
      }
      document.addEventListener(resultEvent, onResult, true);
      document.dispatchEvent(new CustomEvent(requestEvent, {
        detail: {
          requestId: requestId,
          url: String(url || ''),
        },
      }));
    });
  }

  function copyImageBlobToClipboard(imageInfo) {
    // 同步把请求交给孤立世界，让它在当前 click 的用户激活内先提交
    // ClipboardItem Promise；像素读取与 PNG 转码可在之后异步完成。
    return requestTrustedImageAction('copy', imageInfo);
  }

  function downloadImageBlobFromContext(imageInfo) {
    return requestTrustedImageAction('download', imageInfo);
  }
