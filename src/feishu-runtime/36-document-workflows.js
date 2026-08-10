  // ── Unified paste pipeline ─────────────────────────────────────────────────

  // commitPaste handles every "we have a pendingPaste, write the clipboard,
  // optionally upload images, replace tokens, dispatch the paste" operation.
  function commitPaste(content, options) {
    var opts = options || {};
    var canonicalContent = clonePendingPasteData(content);
    if (!canonicalContent) return Promise.reject(new Error('待粘贴内容格式无效'));
    var hasImagesToUpload = !!(canonicalContent.orderedImageBase64List
      && canonicalContent.orderedImageBase64List.length);

    // canonical pending 永远保持源租户数据不变；目标 token 只写入本次粘贴的深拷贝。
    var pipeline = Promise.resolve(canonicalContent);

    if (hasImagesToUpload) {
      if (!opts.silent) showToast('⏳ 准备图片槽位中...', 0);
      pipeline = pipeline.then(function (current) {
        var origRecord = null;
        try { origRecord = current.docxRecord ? JSON.parse(current.docxRecord) : null; }
        catch (error) {}
        if (!origRecord) throw new Error('无法生成目标文档图片槽位');
        current.targetImageDescriptors = buildImagePasteDescriptors(current.orderedImageBase64List);
        current.docxRecord = JSON.stringify(markerizeImagesInDocxRecord(origRecord, current.targetImageDescriptors));
        current.clipboardHtml = markerizeImagesInClipboardHtml(current.clipboardHtml, current.targetImageDescriptors);
        current.hasImagesToInject = false;
        current.hasImagesToUpload = false;
        return current;
      });
    }

    return pipeline.then(function (current) {
      return resolvePastePayload(current).then(function (payload) {
        var needsParser = payloadRequiresPasteParsing(payload);
        var canAutoDispatch = shouldAutoDispatchPastePayload(payload);
        var preferPasteEventOnly = payloadHasFeishuStructuredHtml(payload);
        var hasDowngradedImages = payloadHasDowngradedImages(payload);
        var needsManualPaste = needsParser && !canAutoDispatch;

        return writeClipboardPayload(payload, {
          pasteAfterWrite: opts.dispatch !== false && canAutoDispatch,
        }).then(function (clipboardResult) {
          if (opts.dispatch === false) {
            return { written: true, payload: payload };
          }
          var status = clipboardResult && clipboardResult.pasted
            ? { autoInserted: false, autoPasted: true, pathLabel: describePasteMode('nativePasteCommand') }
            : needsManualPaste
            ? { autoInserted: false, autoPasted: false, pathLabel: describePasteMode('clipboardOnly') }
            : runPasteAttempt(payload, {
                allowInsert: !preferPasteEventOnly,
                allowDispatch: canAutoDispatch,
                allowNativePaste: true,
              });

          if (current.hasImagesToInject
            && current.orderedImageBase64List && current.orderedImageBase64List.length) {
            startImageInjectionObserver();
          }

          if (!opts.silent) {
            if (hasDowngradedImages && needsManualPaste) {
              showToast('📋 检测到图片块已降级到 base64；已写入剪贴板，请直接按 Cmd+V 走飞书原生粘贴以插入图片', 4600);
            } else {
              showPasteResultToast(status, needsManualPaste, true);
            }
          }
          return {
            written: true,
            payload: payload,
            status: status,
            targetImageDescriptors: current.targetImageDescriptors || [],
          };
        }).catch(function () {
          var status = runPasteAttempt(payload, {
            allowInsert: !needsParser && !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
            allowNativePaste: false,
          });
          if (!opts.silent) showPasteResultToast(status, needsManualPaste, false);
          return {
            written: false,
            payload: payload,
            status: status,
            targetImageDescriptors: current.targetImageDescriptors || [],
          };
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
      var transfer = pending.whiteboardTransfer && isValidWhiteboardTransfer(pending.whiteboardTransfer)
        ? pending.whiteboardTransfer
        : null;
      var preflight = transfer
        ? (showToast('⏳ 校验画板迁移环境...', 0), requestWhiteboardPreflight(transfer).catch(function (error) {
            if (!Array.isArray(transfer.browserBoards)) throw error;
            return requestBrowserWhiteboardPreflight(transfer);
          }))
        : Promise.resolve({ needsBodyPaste: true, alreadyComplete: false });

      return preflight.then(function (plan) {
        if (plan && plan.alreadyComplete) {
          showToast('✅ 画板副本已存在，无需重复粘贴', 2600);
          return { whiteboardCount: transfer.boardCount, alreadyComplete: true };
        }

        function applyWhiteboards(result) {
          if (!transfer) return Promise.resolve(result);
          showToast('⏳ 正在重建 ' + transfer.boardCount + ' 个画板...', 0);
          emitUiProgress({ phase: 'whiteboard-apply', done: 0, total: transfer.boardCount, label: '重建画板' });
          var apply = plan && plan.browserFallback
            ? applyBrowserWhiteboards(transfer)
            : requestWhiteboardApply(transfer);
          return apply.then(function (summary) {
            emitUiProgress({
              phase: 'whiteboard-apply',
              done: transfer.boardCount,
              total: transfer.boardCount,
              label: '重建画板',
            });
            showToast('✅ 已重建 ' + transfer.boardCount + ' 个画板', 2600);
            result.whiteboardTransfer = summary || { boardCount: transfer.boardCount };
            return result;
          });
        }

        if (plan && plan.needsBodyPaste === false) {
          return applyWhiteboards({ resumed: true });
        }
        if (!pending.clipboardHtml && pending.html) showToast('⏳ 准备粘贴内容中...', 0);
        var savedSelection = saveCurrentSelection();
        emitUiProgress({ phase: 'body-target', done: 0, total: 0, label: '准备正文' });
        return applyDocumentTitleToCurrentDoc(pending.title).then(function (titleApplied) {
          return waitForDocumentBodyPasteTarget(6000).then(function (focused) {
            if (!focused) {
              restoreCurrentSelection(savedSelection);
              throw new Error('目标文档正文编辑器尚未就绪');
            }
            emitUiProgress({ phase: 'body-paste', done: 0, total: 0, label: '写入正文' });
            return commitPaste(titleApplied ? stripTitleFromContent(pending, pending.title) : pending, {});
          }).then(function (result) {
            return waitForPasteBodySettled(pending, 12000).then(function (settled) {
              if (!settled) throw new Error('粘贴后的完整文档结构加载超时');
              return replaceImageMarkersWithNativePaste(result.targetImageDescriptors, transfer);
            }).then(function (imageSummary) {
              result.imageReconciliation = imageSummary;
              delete result.targetImageDescriptors;
              // Image reconstruction already verifies every marker, staging record,
              // target token and the final structured tree. Keep the second text
              // settling guard only when no image-specific barrier ran.
              return imageSummary && imageSummary.imageCount > 0
                ? true
                : waitForPasteBodySettled(pending, 5000);
            }).then(function () {
              // 飞书正文采用虚拟化渲染，DOM 不保证能同时看到全部 marker；
              // 图片归位直接通过当前编辑器的数据服务完成，不再 reload 丢弃尚未落云的正文。
              return applyWhiteboards(result).then(function (finalResult) {
                return applyPageIconEmojiToCurrentDoc(pending.pageIconEmoji).then(function () {
                  closeHeaderTitleRenameInput();
                  return finalResult;
                });
              });
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
    var activeTransfer = null;
    showToast('⏳ 正在检查并导出画板...', 0);
    emitUiProgress({ phase: 'whiteboard-export', done: 0, total: 0, label: '检查画板' });
    var sourceSummary = null;
    var embeddedChartFallbacks = null;

    // 浏览器 Struct Service 可能只装载局部树；是否存在画板以及槽位集合一律以官方 API 为准。
    return requestWhiteboardExport().then(function (exportResult) {
      var whiteboardTransfer = exportResult && exportResult.whiteboardTransfer;
      sourceSummary = exportResult && exportResult.sourceSummary;
      activeTransfer = whiteboardTransfer;
      if (whiteboardTransfer) {
        emitUiProgress({
          phase: 'whiteboard-export',
          done: whiteboardTransfer.boardCount,
          total: whiteboardTransfer.boardCount,
          label: '导出画板',
        });
      }
      return whiteboardTransfer
        ? waitForWhiteboardSourceTree(whiteboardTransfer, 6000)
        : Promise.resolve();
    }).then(function () {
      emitUiProgress({ phase: 'chart-export', done: 0, total: 0, label: '检查内嵌图表' });
      return captureEmbeddedChartFallbacks();
    }).then(function (chartFallbacks) {
      embeddedChartFallbacks = chartFallbacks;
      if (chartFallbacks && chartFallbacks.count) {
        emitUiProgress({
          phase: 'chart-export', done: chartFallbacks.count,
          total: chartFallbacks.count, label: '导出内嵌图表',
        });
      }
      var content = extractFullDoc(activeTransfer, embeddedChartFallbacks);
      if (!content) throw new Error('提取失败，请确保文档已加载');
      if (activeTransfer && content.whiteboardCount !== activeTransfer.boardCount) {
        throw new Error('画板占位符与源文档结构不一致，请刷新后重试');
      }

      var docTitle = getDocumentTitle();
      var pageIconEmoji = extractPageIconEmojiFromDom();
      return buildClipboardPayload(content).then(function (payload) {
        var validationSnapshot = captureValidationSnapshot();
        var semanticSnapshot = (validationSnapshot && validationSnapshot.semanticSnapshot) || null;
        var hasDowngradedImages = !!(payload && payload.hasDowngradedImages)
          || /data-feishu-downgraded-images="true"/i.test(String((payload && payload.html) || ''));
        var hasImagesToInject = !!(payload && payload.hasImagesToInject);
        var orderedImageBase64List = (payload && payload.orderedImageBase64List) || [];
        var withBase64 = orderedImageBase64List.filter(function (img) { return !!img.base64; }).length;
        var pending = {
          html: content.html,
          text: content.text,
          clipboardHtml: (payload && payload.html) || '',
          docxRecord: (payload && payload.docxRecord) || '',
          title: docTitle,
          pageIconEmoji: pageIconEmoji,
          hasDowngradedImages: hasDowngradedImages,
          hasImagesToInject: hasImagesToInject,
          hasImagesToUpload: !!(payload && payload.hasImagesToUpload),
          orderedImageBase64List: orderedImageBase64List,
          semanticSnapshot: semanticSnapshot,
        };
        if (activeTransfer) pending.whiteboardTransfer = activeTransfer;

        return setPendingPaste(pending).then(function () {
          var imgCount = Number(sourceSummary && sourceSummary.imageCount);
          var inlinedImgCount = (String((payload && payload.html) || '').match(/data:image/g) || []).length;
          var injectCount = orderedImageBase64List.length;
          var officialBlockCount = Number(sourceSummary && sourceSummary.blockCount);
          var officialEquationCount = Number(sourceSummary && sourceSummary.equationCount);
          var toastMsg = '已提取 ' + officialBlockCount + ' 块 · ' + officialEquationCount
            + ' 公式 · ' + imgCount + ' 图片';
          if (activeTransfer) toastMsg += ' · ' + activeTransfer.boardCount + ' 画板';
          if (embeddedChartFallbacks && embeddedChartFallbacks.count) {
            toastMsg += ' · ' + embeddedChartFallbacks.count + ' 内嵌图表已转图片';
          }
          if (injectCount > 0) toastMsg += ' · ' + injectCount + ' 张待注入';
          showToast(toastMsg, 3600);

          var result = {
            title: docTitle,
            pageIconEmoji: pageIconEmoji,
            blockCount: officialBlockCount,
            equationCount: officialEquationCount,
            imageCount: imgCount,
            whiteboardCount: activeTransfer ? activeTransfer.boardCount : 0,
            embeddedChartCount: Number(embeddedChartFallbacks && embeddedChartFallbacks.count || 0),
            inlinedImageCount: inlinedImgCount,
            textLen: String(content.text || '').length,
            htmlLen: String(content.html || '').length,
            clipboardHtmlLen: String((payload && payload.html) || '').length,
            hasDowngradedImages: hasDowngradedImages,
            hasImagesToInject: hasImagesToInject,
            imageInjectCount: orderedImageBase64List.length,
            imageInjectWithBase64: withBase64,
            semanticSnapshot: semanticSnapshot,
          };
          setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, result, { ts: Date.now() }));
          return result;
        });
      }, function (error) {
        if (activeTransfer || (embeddedChartFallbacks && embeddedChartFallbacks.count)) throw error;
        var fallbackSnapshot = captureValidationSnapshot();
        var fallbackSemantic = (fallbackSnapshot && fallbackSnapshot.semanticSnapshot) || null;
        return setPendingPaste({
          html: content.html,
          text: content.text,
          title: docTitle,
          pageIconEmoji: pageIconEmoji,
          semanticSnapshot: fallbackSemantic,
        }).then(function () {
          var imgCount = Number(sourceSummary && sourceSummary.imageCount);
          showToast('⚠️ 内容已提取，但图片预处理失败，粘贴时可能退回纯文本 · ' + imgCount + ' 图片', 3500);
          var fallbackResult = {
            title: docTitle,
            pageIconEmoji: pageIconEmoji,
            blockCount: Number(sourceSummary && sourceSummary.blockCount),
            equationCount: Number(sourceSummary && sourceSummary.equationCount),
            imageCount: imgCount,
            whiteboardCount: 0,
            inlinedImageCount: 0,
            textLen: String(content.text || '').length,
            htmlLen: String(content.html || '').length,
            clipboardHtmlLen: 0,
            payloadError: true,
            semanticSnapshot: fallbackSemantic,
          };
          setDocJsonAttr('data-feishu-extraction-result', Object.assign({}, fallbackResult, { ts: Date.now() }));
          return fallbackResult;
        });
      });
    }).catch(function (error) {
      var discard = activeTransfer ? requestWhiteboardDiscard(activeTransfer, 'extract') : Promise.resolve(false);
      return discard.then(function () {
        showToast('⚠️ 提取失败：' + stringifyError(error), 4200);
        throw error;
      });
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

  // ── Native paste preparation ───────────────────────────────────────────────
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
