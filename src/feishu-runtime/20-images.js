  // ── Image fetching & base64 conversion ─────────────────────────────────────

  function blobToBase64(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.readAsDataURL(blob);
    });
  }

  function fetchImageAsBase64(url) {
    return originalFetch(url, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) { return blob ? blobToBase64(blob) : null; })
      .catch(function () { return null; });
  }

  // Replace every Feishu image src in the html with a placeholder, returning
  // the new html plus a token -> base64 map for later injection.
  function convertImagesToBase64(html) {
    var imgUrls = [];
    var tokenToBase64 = {};
    var urlRegex = /src="(https?:\/\/[^"]+?(?:\/space\/api\/box\/stream\/download\/(?:preview\/|v2\/cover\/|all\/)|(?:feishucdn\.com\/static-resource\/v1\/))([A-Za-z0-9_.~-]+)[^"]*)"/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
      imgUrls.push({ url: match[1], full: match[0], token: match[2] });
    }
    if (!imgUrls.length) return Promise.resolve({ html: html, tokenToBase64: {} });

    var done = 0;
    var total = imgUrls.length;
    var nextIndex = 0;
    var concurrency = Math.min(5, imgUrls.length);
    showToast('📷 转换图片中 0/' + total);
    emitUiProgress({ phase: 'convert', done: 0, total: total, label: '转换图片' });

    function convertOne(item) {
      return fetchImageAsBase64(item.url).then(function (base64) {
        done++;
        showToast('📷 转换图片中 ' + done + '/' + total);
        emitUiProgress({ phase: 'convert', done: done, total: total, label: '转换图片' });
        if (base64) {
          html = html.replace(item.full, 'src="' + IMAGE_PLACEHOLDER_SRC + '"');
          if (item.token) tokenToBase64[item.token] = base64;
        }
      });
    }

    function worker() {
      if (nextIndex >= imgUrls.length) return Promise.resolve();
      var item = imgUrls[nextIndex];
      nextIndex += 1;
      return convertOne(item).then(worker);
    }

    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());

    return Promise.all(workers).then(function () { return { html: html, tokenToBase64: tokenToBase64 }; });
  }

  // ── Image upload via Feishu internal API ───────────────────────────────────

  function discoverWikiObjToken(docToken) {
    return originalFetch(
      '/space/api/wiki/v2/tree/get_node/?wiki_token=' + encodeURIComponent(docToken)
        + '&expand_shortcut=true&with_deleted=true',
      { credentials: 'include' }
    )
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var node = (data && data.data && data.data.node) || (data && data.data) || {};
        return node.obj_token || '';
      })
      .catch(function () { return ''; });
  }

  function resolveTargetDocToken() {
    var docToken = '';
    var isWiki = false;
    try {
      var match = location.pathname.match(/\/(docx|wiki|doc)\/([A-Za-z0-9]+)/);
      if (match) {
        isWiki = match[1] === 'wiki';
        docToken = match[2];
      }
    } catch (e) {}
    if (isWiki && docToken) {
      return discoverWikiObjToken(docToken).then(function (objToken) {
        return objToken || docToken;
      });
    }
    return Promise.resolve(docToken);
  }

  function uploadBase64ImageViaApi(base64Data, objToken) {
    var dataUrl = String(base64Data || '').indexOf('data:') === 0
      ? base64Data
      : 'data:image/png;base64,' + base64Data;
    var base64Part = dataUrl.split(',')[1] || '';
    var mimeMatch = dataUrl.match(/data:(image\/\w+);/);
    var mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    var ext = mimeType.split('/')[1] || 'png';

    var byteString = atob(base64Part);
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    var blob = new Blob([ab], { type: mimeType });
    var fileName = 'image.' + ext;
    var fileSize = blob.size;

    var url = '/space/api/box/stream/upload/all/?name=' + encodeURIComponent(fileName)
      + '&size=' + fileSize
      + '&mount_point=docx_image'
      + '&mount_node_token=' + encodeURIComponent(objToken || '')
      + '&push_open_history_record=0';

    var formData = new FormData();
    formData.append('file', blob, fileName);

    return originalFetch(url, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: { 'biz-ua-type': 'Web', 'biz-scene': 'file_upload' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var token = '';
        if (data && data.data) token = data.data.token || data.data.file_token || data.data.image_key || '';
        if (!token && data && data.result) token = data.result.token || data.result.file_token || data.result.image_key || '';
        return { token: token };
      })
      .catch(function (err) { return { token: '', error: stringifyError(err) }; });
  }

  function uploadAllImages(orderedImageBase64List) {
    var images = orderedImageBase64List || [];
    if (!images.length) {
      return Promise.resolve({ tokenMap: {}, attemptedCount: 0, uploadedCount: 0, failedCount: 0 });
    }

    return resolveTargetDocToken().then(function (objToken) {
      var tokenMap = {};
      var uploadedCount = 0;
      var failedCount = 0;
      var processedCount = 0;
      var nextIndex = 0;
      var concurrency = Math.min(4, images.length);

      emitUiProgress({ phase: 'upload', done: 0, total: images.length, label: '上传图片' });

      function uploadOne(img) {
        return Promise.resolve().then(function () {
          if (!img.base64) return { token: '', error: 'no base64 data' };
          return uploadBase64ImageViaApi(img.base64, objToken);
        }).then(function (result) {
          if (result && result.token) {
            tokenMap[img.token] = result.token;
            uploadedCount += 1;
          } else {
            failedCount += 1;
          }
        }).catch(function () { failedCount += 1; }).then(function () {
          processedCount += 1;
          emitUiProgress({ phase: 'upload', done: processedCount, total: images.length, label: '上传图片' });
        });

      }

      function worker() {
        if (nextIndex >= images.length) return Promise.resolve();
        var img = images[nextIndex];
        nextIndex += 1;
        return uploadOne(img).then(worker);
      }

      var workers = [];
      for (var i = 0; i < concurrency; i++) workers.push(worker());

      return Promise.all(workers).then(function () {
        return {
          tokenMap: tokenMap,
          attemptedCount: images.length,
          uploadedCount: uploadedCount,
          failedCount: failedCount,
        };
      });
    });
  }

  // ── Image injection observer (for paste flows that leave img placeholders) ─

  function injectBase64ImagesIntoEditor(orderedImageBase64List) {
    var list = orderedImageBase64List || [];
    if (!list.length) return 0;
    var editable = getContentRootElement();
    if (!editable) return 0;
    var imageBlocks = editable.querySelectorAll('[data-block-type="image"]');
    if (!imageBlocks.length) return 0;

    var injected = 0;
    imageBlocks.forEach(function (block, index) {
      if (index >= list.length) return;
      var imageData = list[index];
      if (!imageData || !imageData.base64) return;
      var dataUrl = imageData.base64.indexOf('data:') === 0
        ? imageData.base64
        : 'data:image/png;base64,' + imageData.base64;

      var img = block.querySelector('img');
      if (img) {
        if (img.src !== dataUrl) img.src = dataUrl;
        if (imageData.width) img.setAttribute('width', imageData.width);
        if (imageData.height) img.setAttribute('height', imageData.height);
        injected++;
        return;
      }

      var container = block.querySelector(
        '.img, [class*="image-content"], [class*="img-container"], [class*="ImgContainer"], [class*="image-wrap"]'
      );
      if (container) {
        var newImg = document.createElement('img');
        newImg.src = dataUrl;
        newImg.style.cssText = 'max-width:100%;height:auto;display:block;';
        if (imageData.width) newImg.setAttribute('width', imageData.width);
        if (imageData.height) newImg.setAttribute('height', imageData.height);
        container.appendChild(newImg);
        injected++;
      }
    });

    return injected;
  }

  var imageInjectionObserver = null;
  var imageInjectionRetryCount = 0;
  var MAX_IMAGE_INJECTION_RETRIES = 8;

  function stopImageInjectionObserver() {
    if (imageInjectionObserver) {
      clearTimeout(imageInjectionObserver._timer);
      imageInjectionObserver.disconnect();
      imageInjectionObserver = null;
    }
    imageInjectionRetryCount = 0;
  }

  function startImageInjectionObserver() {
    if (imageInjectionObserver) return;
    var target = getContentRootElement() || document.body;
    if (!target) return;
    imageInjectionObserver = new MutationObserver(function () {
      clearTimeout(imageInjectionObserver._timer);
      imageInjectionObserver._timer = setTimeout(function () {
        getPendingPaste().then(function (pending) {
          var list = (pending && pending.orderedImageBase64List) || [];
          if (!list.length) {
            // 没有待注入数据时不应继续常驻监听，避免误改页面图片。
            stopImageInjectionObserver();
            return;
          }
          var count = injectBase64ImagesIntoEditor(list);
          if (count >= list.length) {
            // 全部注入完成，立即停止监听，防止后续持续覆盖导致图片抖动/错位。
            stopImageInjectionObserver();
          } else if (count > 0 && imageInjectionRetryCount < MAX_IMAGE_INJECTION_RETRIES) {
            imageInjectionRetryCount++;
            setTimeout(function () {
              getPendingPaste().then(function (next) {
                if (next && next.orderedImageBase64List) {
                  injectBase64ImagesIntoEditor(next.orderedImageBase64List);
                }
              });
            }, 1500);
          }
        });
      }, 500);
    });
    imageInjectionObserver.observe(target, { childList: true, subtree: true });
    registerDisposer(function () {
      if (imageInjectionObserver) {
        imageInjectionObserver.disconnect();
        imageInjectionObserver = null;
      }
    });

    // 兜底：粘贴后 20 秒内若仍未完成注入，强制停止，避免观察器长期常驻。
    setTimeout(stopImageInjectionObserver, 20000);
  }
