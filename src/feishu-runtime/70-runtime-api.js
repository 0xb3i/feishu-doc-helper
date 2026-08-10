  // Expose a tiny module surface mostly so tests can assert userscript shape.
  window.__feishuHelperRuntime.modules = {
    extraction: {
      extractFullDoc: extractFullDoc,
      extractPageIconEmojiFromDom: extractPageIconEmojiFromDom,
      captureValidationSnapshot: captureValidationSnapshot,
      getEditorReadyState: getEditorReadyState,
    },
    clipboard: {
      buildClipboardPayload: buildClipboardPayload,
      writeClipboardPayload: writeClipboardPayload,
      applyPageIconEmojiToCurrentDoc: applyPageIconEmojiToCurrentDoc,
    },
  };
