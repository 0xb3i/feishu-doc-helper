(function (root) {
  'use strict';

  function dataUrlToBlob(dataUrl) {
    var separator = dataUrl.indexOf(';base64,');
    var mime = dataUrl.slice(5, separator);
    var binary = atob(dataUrl.slice(separator + 8));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function toPngBlob(blob) {
    if (blob.type === 'image/png') return Promise.resolve(blob);
    return createImageBitmap(blob).then(function (bitmap) {
      var canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (typeof bitmap.close === 'function') bitmap.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (pngBlob) {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('clipboard image conversion returned no data'));
        }, 'image/png');
      });
    });
  }

  function writeImageDataUrl(imageDataUrl) {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
      return Promise.reject(new Error('binary clipboard API is unavailable'));
    }
    return writeImageBlobPromise(Promise.resolve(dataUrlToBlob(String(imageDataUrl || ''))));
  }

  // ClipboardItem 允许 value 为 Promise。必须在用户点击的同步调用栈内先调
  // navigator.clipboard.write，再等待图片读取/转码；否则 Chrome 会因用户激活
  // 已过期返回 PermFail。
  function writeImageBlobPromise(blobPromise) {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
      return Promise.reject(new Error('binary clipboard API is unavailable'));
    }
    var pngPromise = Promise.resolve(blobPromise).then(toPngBlob);
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
  }

  root.FeishuExtensionImageClipboard = Object.freeze({
    dataUrlToBlob: dataUrlToBlob,
    toPngBlob: toPngBlob,
    writeImageBlobPromise: writeImageBlobPromise,
    writeImageDataUrl: writeImageDataUrl,
  });
})(globalThis);
