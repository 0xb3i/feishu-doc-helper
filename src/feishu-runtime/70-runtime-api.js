  // Expose a tiny module surface mostly so tests can assert userscript shape.
  window.__feishuHelperRuntime.modules = {
    extraction: {
      extractFullDoc: extractFullDoc,
      extractPageIconEmojiFromDom: extractPageIconEmojiFromDom,
      duplicateDocumentForAutomation: duplicateDocumentForAutomation,
      preparePendingPasteForNativePaste: preparePendingPasteForNativePaste,
      captureValidationSnapshot: captureValidationSnapshot,
      getEditorReadyState: getEditorReadyState,
    },
    clipboard: {
      buildClipboardPayload: buildClipboardPayload,
      writeClipboardPayload: writeClipboardPayload,
      applyPageIconEmojiToCurrentDoc: applyPageIconEmojiToCurrentDoc,
      pasteIntoDoc: pasteIntoDoc,
    },
    automation: {
      runAutomationAction: runAutomationAction,
      requestEvent: AUTOMATION_REQUEST_EVENT,
      resultEvent: AUTOMATION_RESULT_EVENT,
    },
  };
