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
