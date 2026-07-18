  // ── Unified paste pipeline ─────────────────────────────────────────────────

  // commitPaste handles every "we have a pendingPaste, write the clipboard,
  // optionally upload images, replace tokens, dispatch the paste".  Both the
  // user-driven Cmd+Shift+P shortcut and the runner-driven
  // `feishu-prepare-native-paste` event funnel through here.
  function commitPaste(content, options) {
    var opts = options || {};
    var hasImagesToUpload = !!(content.orderedImageBase64List && content.orderedImageBase64List.length)
      && Object.keys(uploadedTokenMap).length === 0;

    var pipeline = Promise.resolve(content);

    if (hasImagesToUpload) {
      if (!opts.silent) showToast('⏳ 上传图片中...', 0);
      pipeline = pipeline.then(function (current) {
        return uploadAllImages(current.orderedImageBase64List).then(function (summary) {
          var tokenMap = (summary && summary.tokenMap) || {};
          var uploaded = Number((summary && summary.uploadedCount) || 0);
          var failed = Number((summary && summary.failedCount) || 0);
          setDocJsonAttr('data-feishu-upload-result', {
            tokenMap: tokenMap,
            uploadedCount: uploaded,
            failedCount: failed,
            attemptedCount: Number((summary && summary.attemptedCount) || 0),
          });
          if (uploaded > 0) {
            mergeUploadedTokenMap(tokenMap);
            var origRecord = null;
            try { origRecord = current.docxRecord ? JSON.parse(current.docxRecord) : null; }
            catch (error) {}
            if (origRecord) {
              current.docxRecord = JSON.stringify(docxRecord.replaceTokensInDocxRecord(origRecord, tokenMap));
              current.hasImagesToInject = false;
              current.hasImagesToUpload = false;
              return setPendingPaste(current).then(function () {
                if (!opts.silent) {
                  showToast('✅ ' + uploaded + ' 张图片已上传' + (failed ? '，失败 ' + failed + ' 张' : ''), 1500);
                }
                return current;
              });
            }
          }
          if (!opts.silent) {
            showToast('✅ ' + uploaded + ' 张图片已上传' + (failed ? '，失败 ' + failed + ' 张' : ''), 1500);
          }
          return current;
        }).catch(function () {
          if (!opts.silent) showToast('⚠️ 图片上传失败，将粘贴不含图片的内容', 3000);
          return current;
        });
      });
    }

    return pipeline.then(function (current) {
      return resolvePastePayload(current).then(function (payload) {
        var needsParser = payloadRequiresPasteParsing(payload);
        var canAutoDispatch = shouldAutoDispatchPastePayload(payload);
        var preferPasteEventOnly = payloadHasFeishuStructuredHtml(payload);
        var hasDowngradedImages = payloadHasDowngradedImages(payload);
        var needsManualPaste = needsParser && !canAutoDispatch;

        return writeClipboardPayload(payload).then(function () {
          if (opts.dispatch === false) {
            return { written: true, payload: payload };
          }
          var status = needsManualPaste
            ? { autoInserted: false, autoPasted: false, pathLabel: describePasteMode('clipboardOnly') }
            : runPasteAttempt(payload, {
                allowInsert: !preferPasteEventOnly,
                allowDispatch: canAutoDispatch,
              });

          if (current.orderedImageBase64List && current.orderedImageBase64List.length) {
            startImageInjectionObserver();
          }

          if (!opts.silent) {
            if (hasDowngradedImages && needsManualPaste) {
              showToast('📋 检测到图片块已降级到 base64；已写入剪贴板，请直接按 Cmd+V 走飞书原生粘贴以插入图片', 4600);
            } else {
              showPasteResultToast(status, needsManualPaste, true);
            }
          }
          return { written: true, payload: payload, status: status };
        }).catch(function () {
          var status = runPasteAttempt(payload, {
            allowInsert: !needsParser && !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
          });
          if (!opts.silent) showPasteResultToast(status, needsManualPaste, false);
          return { written: false, payload: payload, status: status };
        });
      });
    });
  }

  function pasteIntoDoc() {
    if (!getDocToken() || !getContentRootElement()) {
      return Promise.reject(new Error('当前页面不是可编辑的飞书文档正文。'));
    }
    return getPendingPaste().then(function (pending) {
      if (!pending) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }
      if (!pending.clipboardHtml && pending.html) {
        showToast('⏳ 准备粘贴内容中...', 0);
      }
      var savedSelection = saveCurrentSelection();
      return applyDocumentTitleToCurrentDoc(pending.title).then(function (titleApplied) {
        if (!focusDocumentBodyForPaste()) restoreCurrentSelection(savedSelection);
        return commitPaste(titleApplied ? stripTitleFromContent(pending, pending.title) : pending, {}).then(function (result) {
          return waitForPasteBodySettled(pending, 5000).then(function () {
            return applyPageIconEmojiToCurrentDoc(pending.pageIconEmoji).then(function () {
              closeHeaderTitleRenameInput();
              return result;
            });
          });
        });
      });
    });
  }

  // ── Extraction entry point ─────────────────────────────────────────────────

  function duplicateDocumentForAutomation() {
    var token = getDocToken();
    if (!token) {
      showToast('⚠️ 无法识别当前文档');
      return Promise.reject(new Error('无法识别当前文档'));
    }

    showToast('⏳ 提取文档中...', 0);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var content = extractFullDoc();
        if (!content) {
          showToast('⚠️ 提取失败，请确保文档已加载');
          reject(new Error('提取失败，请确保文档已加载'));
          return;
        }

        var docTitle = getDocumentTitle();
        var pageIconEmoji = extractPageIconEmojiFromDom();
        buildClipboardPayload(content).then(function (payload) {
          var validationSnapshot = captureValidationSnapshot();
          var semanticSnapshot = (validationSnapshot && validationSnapshot.semanticSnapshot) || null;
          var hasDowngradedImages = !!(payload && payload.hasDowngradedImages)
            || /data-feishu-downgraded-images="true"/i.test(String((payload && payload.html) || ''));
          var hasImagesToInject = !!(payload && payload.hasImagesToInject);
          var orderedImageBase64List = (payload && payload.orderedImageBase64List) || [];
          var withBase64 = orderedImageBase64List.filter(function (img) { return !!img.base64; }).length;
          var effectiveDocxRecord = (payload && payload.docxRecord) || '';

          return setPendingPaste({
            html: content.html,
            text: content.text,
            clipboardHtml: payload.html,
            docxRecord: effectiveDocxRecord,
            title: docTitle,
            pageIconEmoji: pageIconEmoji,
            hasDowngradedImages: hasDowngradedImages,
            hasImagesToInject: hasImagesToInject,
            hasImagesToUpload: !!(payload && payload.hasImagesToUpload),
            orderedImageBase64List: orderedImageBase64List,
            semanticSnapshot: semanticSnapshot,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            var inlinedImgCount = (payload.html.match(/data:image/g) || []).length;
            var injectCount = orderedImageBase64List.length;
            var toastMsg = '✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片';
            if (injectCount > 0) toastMsg += ' · ' + injectCount + ' 张待注入';
            showToast(toastMsg, 3200);

            var result = {
              title: docTitle,
              pageIconEmoji: pageIconEmoji,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: inlinedImgCount,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: String(payload.html || '').length,
              hasDowngradedImages: hasDowngradedImages,
              hasImagesToInject: hasImagesToInject,
              imageInjectCount: orderedImageBase64List.length,
              imageInjectWithBase64: withBase64,
              semanticSnapshot: semanticSnapshot,
            };
            setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, result, { ts: Date.now() }));
            resolve(result);
          });
        }).catch(function () {
          var fallbackSnapshot = captureValidationSnapshot();
          var fallbackSemantic = (fallbackSnapshot && fallbackSnapshot.semanticSnapshot) || null;
          setPendingPaste({
            html: content.html,
            text: content.text,
            title: docTitle,
            pageIconEmoji: pageIconEmoji,
            semanticSnapshot: fallbackSemantic,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            showToast('⚠️ 内容已提取，但图片预处理失败，粘贴时可能退回纯文本 · ' + imgCount + ' 图片', 3500);
            var result = {
              title: docTitle,
              pageIconEmoji: pageIconEmoji,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: 0,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: 0,
              payloadError: true,
              semanticSnapshot: fallbackSemantic,
            };
            setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, result, { ts: Date.now() }));
            resolve(result);
          }).catch(reject);
        });
        } catch (error) {
          reject(error);
        }
      }, 50);
    });
  }

  function buildValidateDuplicateDocumentSummary() {
    return duplicateDocumentForAutomation().then(function (extraction) {
      var validationSnapshot = captureValidationSnapshot();
      return getPendingPaste().then(function (pending) {
        var summary = Object.assign({}, extraction);
        if (validationSnapshot) {
          summary.validationSnapshot = validationSnapshot;
          summary.semanticSnapshot = validationSnapshot.semanticSnapshot || null;
        }
        if (pending) {
          summary.pendingPaste = {
            title: String(pending.title || ''),
            pageIconEmoji: String(pending.pageIconEmoji || ''),
            textLen: String(pending.text || '').length,
            htmlLen: String(pending.html || '').length,
            clipboardHtmlLen: String(pending.clipboardHtml || '').length,
            hasDowngradedImages: Boolean(pending.hasDowngradedImages),
            semanticSnapshot: pending.semanticSnapshot || null,
            ts: Number(pending.ts || 0),
          };
        } else {
          summary.pendingError = 'Pending paste cache was not updated.';
        }
        return summary;
      });
    });
  }

  // ── Native paste preparation (runner uses this) ────────────────────────────

  // The runner dispatches `feishu-prepare-native-paste` and then issues
  // Cmd+Shift+P / Cmd+V from outside the page.  This rewrites the clipboard
  // (and the pendingPaste cache) so that whatever the runner presses next
  // sees a payload with valid image tokens — uploading first if necessary.
  function preparePendingPasteForNativePaste() {
    return getPendingPaste().then(function (pending) {
      if (!pending) {
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }
      return commitPaste(pending, { dispatch: false, silent: true }).then(function () {
        return getPendingPaste().then(function (latest) {
          var resolved = latest || pending;
          return resolvePastePayload(resolved).then(function (payload) {
            return {
              title: String(resolved.title || ''),
              textLength: String((payload && payload.text) || '').length,
              htmlLength: String((payload && payload.html) || '').length,
              requiresNativePaste: payloadRequiresPasteParsing(payload),
              canAutoDispatch: shouldAutoDispatchPastePayload(payload),
            };
          });
        });
      });
    });
  }
