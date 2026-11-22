const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/feishu-extension');
const PACKAGE_VERSION = require('../package.json').version;

function runExtensionBuild() {
  return spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FEISHU_EXTENSION_SKIP_RELOAD: '1' }),
  });
}

const artifacts = {};

before(() => {
  fs.rmSync(DIST, { recursive: true, force: true });
  const result = runExtensionBuild();
  assert.equal(result.status, 0, result.stdout + result.stderr);

  artifacts.manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  artifacts.mainWorld = fs.readFileSync(path.join(DIST, 'content/main-world.js'), 'utf8');
  artifacts.bridge = fs.readFileSync(path.join(DIST, 'content/bridge.js'), 'utf8');
  artifacts.imageClipboard = fs.readFileSync(path.join(DIST, 'shared/image-clipboard.js'), 'utf8');
  artifacts.serviceWorker = fs.readFileSync(path.join(DIST, 'background/service-worker.js'), 'utf8');
  artifacts.popupHtml = fs.readFileSync(path.join(DIST, 'popup/popup.html'), 'utf8');
  artifacts.popupJs = fs.readFileSync(path.join(DIST, 'popup/popup.js'), 'utf8');
  artifacts.popupCss = fs.readFileSync(path.join(DIST, 'popup/popup.css'), 'utf8');
  artifacts.popupSource = fs.readFileSync(path.join(ROOT, 'extension/popup/popup.js'), 'utf8');
});

test('build emits a loadable MV3 extension with a popup dashboard menu', () => {
  const manifest = artifacts.manifest;
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.equal(manifest.version, PACKAGE_VERSION);
  assert.equal(manifest.name, '飞书文档助手');
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  assert.equal(manifest.side_panel, undefined);
  assert.deepEqual(manifest.permissions.sort(), [
    'alarms', 'clipboardRead', 'clipboardWrite', 'commands', 'contextMenus',
    'nativeMessaging', 'storage', 'unlimitedStorage',
  ].sort());
  assert.equal(typeof manifest.key, 'string');
  assert.ok(manifest.key.length > 100);
  assert.ok(manifest.host_permissions.includes('https://*.feishu.cn/docx/*'));
  assert.ok(manifest.host_permissions.includes('https://*.larksuite.com/wiki/*'));
  assert.ok(manifest.host_permissions.includes('https://*.feishucdn.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.feishu.cn/space/api/file/f/cdp-chart-*'));
  assert.ok(!manifest.host_permissions.includes('https://*.bytedance.net/*'));
  assert.ok(!manifest.host_permissions.includes('https://*.feishu.cn/*'));

  const scripts = manifest.content_scripts.flatMap(function (entry) {
    return (entry.js || []).map(function (scriptPath) {
      return { scriptPath: scriptPath, world: entry.world || 'ISOLATED' };
    });
  });
  assert.ok(scripts.some(function (entry) {
    return entry.scriptPath === 'content/main-world.js' && entry.world === 'MAIN';
  }));
  assert.ok(scripts.some(function (entry) {
    return entry.scriptPath === 'content/bridge.js' && entry.world === 'ISOLATED';
  }));
  const isolatedScripts = manifest.content_scripts.find(function (entry) { return !entry.world; }).js;
  assert.deepEqual(isolatedScripts, [
    'shared/protocol.js', 'shared/image-clipboard.js', 'content/image-panel-styles.js',
    'content/image-panel.js', 'content/bridge.js',
  ]);

  [
    'content/main-world.js',
    'content/bridge.js',
    'shared/protocol.js',
    'shared/image-clipboard.js',
    'background/service-worker.js',
    'popup/popup.html',
    'popup/popup.js',
    'popup/popup.css',
    'shared/base.css',
    'content/image-panel.js',
    'content/image-panel-styles.js',
  ].forEach(function (relativePath) {
    assert.ok(fs.existsSync(path.join(DIST, relativePath)), relativePath + ' should exist');
  });

  assert.match(artifacts.popupHtml, /src="popup\.js"/);
  assert.match(artifacts.popupHtml, /href="popup\.css"/);
  ['提取', '粘贴', '仅提取图片', '刷新快照'].forEach(function (label) {
    assert.ok(artifacts.popupHtml.includes(label), label + ' should be rendered by the popup');
  });
  assert.ok(artifacts.popupCss.length > 0, 'popup stylesheet should not be empty');
  assert.doesNotMatch(manifest.name, /ant/i);
  assert.doesNotMatch(JSON.stringify(manifest), /sidepanel|side_panel|sidePanel/);
  assert.match(artifacts.mainWorld, new RegExp("var SCRIPT_VERSION = '" + PACKAGE_VERSION.replace(/\./g, '\\.') + "'"));
  assert.doesNotMatch(artifacts.mainWorld, /__FEISHU_HELPER_VERSION__/);
});

test('extension build supports opt-in reload of the unpacked browser extension', () => {
  const buildScript = fs.readFileSync(path.join(ROOT, 'bin/build-feishu-extension.cjs'), 'utf8');
  const reloadScript = fs.readFileSync(path.join(ROOT, 'bin/reload-feishu-extension.cjs'), 'utf8');

  assert.match(buildScript, /FEISHU_EXTENSION_RELOAD !== '1'/);
  assert.match(buildScript, /reload-feishu-extension\.cjs/);
  assert.match(reloadScript, /chrome\.runtime\.reload\(\)/);
  assert.match(reloadScript, /chrome:\/\/extensions/);
});

test('extension bridge exposes first-class UI actions instead of simulating shortcuts', () => {
  assert.match(artifacts.mainWorld, /feishu-helper:ui-action/);
  assert.match(artifacts.bridge, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(artifacts.bridge, /protocol\.DOM_EVENTS\.UI_ACTION/);
  assert.match(artifacts.popupJs, /source: MESSAGES.UI, action/);
});

test('pending paste is shared through extension storage and missing cache fails visibly', () => {
  assert.match(artifacts.mainWorld, /feishu-helper:pending-paste/);
  assert.match(artifacts.mainWorld, /请先在源文档按 Cmd\+Shift\+D 提取/);
  assert.match(artifacts.bridge, /protocol\.MESSAGES\.PENDING_PASTE/);
  assert.match(artifacts.serviceWorker, /feishu-pending-paste/);
});

test('whiteboard transfer uses scoped Native Messaging with immutable source handles', () => {
  assert.match(artifacts.bridge, /protocol\.NATIVE_MESSAGING\.REQUEST_TYPE/);
  assert.match(artifacts.serviceWorker, /chrome\.runtime\.sendNativeMessage/);
  assert.match(artifacts.mainWorld, /requestWhiteboardExport\(\)/);
  assert.match(artifacts.mainWorld, /requestDocumentInspect\(\)/);
  assert.match(artifacts.mainWorld, /requestBrowserWhiteboardPreflight\(transfer\)/);
  assert.match(artifacts.mainWorld, /applyBrowserWhiteboards\(transfer\)/);
  assert.doesNotMatch(artifacts.mainWorld, /requestWhiteboard(?:Preflight|Apply)\(transfer\)/);
  assert.match(artifacts.mainWorld, /cloneBlockTreeWithWhiteboardMarkers/);
  assert.match(artifacts.mainWorld, /canonical pending 永远保持源租户数据不变/);
  assert.ok(artifacts.popupSource.includes('画板'));
  assert.match(artifacts.serviceWorker, /完全退出并重新打开 Chrome 后重试/);
});

test('image metrics use the same docx record source as paste payloads', () => {
  assert.match(artifacts.mainWorld, /buildImageEntriesFromDocxRecord\(\{ recordMap: collectDocumentImageRecords\(service\.rootBlock\) \}\)/);
  assert.match(artifacts.mainWorld, /imageCount: countExtractedImages\(content\)/);
  assert.doesNotMatch(artifacts.mainWorld, /function extractDomImages/);
  assert.doesNotMatch(artifacts.mainWorld, /document\.querySelectorAll\('img'\)\.forEach/);
  assert.doesNotMatch(artifacts.mainWorld, /document\.querySelectorAll\('\[style\*="background-image"\]'\)\.forEach/);
});

test('batch image extraction uses the scoped background bridge without a global fetch hook', () => {
  assert.match(artifacts.mainWorld, /return fetchImageViaBackground\(url\)/);
  assert.match(artifacts.bridge, /activeAction === protocol\.ACTIONS\.EXTRACT/);
  assert.match(artifacts.bridge, /if \(!actionAllowsBatchFetch && !gestureAllowsFetch\)/);
  assert.doesNotMatch(artifacts.mainWorld, /originalFetch/);
  assert.doesNotMatch(artifacts.mainWorld, /window\.fetch\s*=/);
  assert.match(artifacts.mainWorld, /图片预处理不完整/);
  assert.match(artifacts.mainWorld, /convertImagesToBase64\(/);
  assert.match(artifacts.mainWorld, /var total = workItems\.reduce/);
  assert.match(artifacts.mainWorld, /location\.origin \+ '\/space\/api\/box\/stream\/download\/all/);
  assert.doesNotMatch(artifacts.mainWorld, /pending image base64 must be a non-empty data URL/);
});

test('image right-click is suppressed in the isolated bridge before Feishu handlers', () => {
  assert.match(artifacts.bridge, /window\.addEventListener\(type, suppressFeishuImageRightButton, true\)/);
  assert.match(artifacts.bridge, /event\.stopImmediatePropagation\(\)/);
  assert.match(artifacts.bridge, /\[data-block-type="image"\]/);
  assert.match(artifacts.bridge, /IMAGE_CONTEXT_COPY_EVENT/);
  assert.match(artifacts.bridge, /event\.type === 'contextmenu'/);
  assert.match(artifacts.bridge, /gestureIsFresh/);
  assert.match(artifacts.bridge, /imageElement: getImageElementAtPoint\(event\)/);
  assert.match(artifacts.bridge, /lastImageContextGesture = null/);
  assert.match(artifacts.bridge, /writeTrustedContextImage\(trustedImage\.blobPromise\)/);
  assert.doesNotMatch(artifacts.mainWorld, /suppressFeishuRightButton/);
  assert.match(artifacts.mainWorld, /openImageMenu\(e\.clientX, e\.clientY, info\)/);
  assert.match(artifacts.mainWorld, /el\.setAttribute\('tabindex', '0'\)/);
  assert.match(artifacts.mainWorld, /window\.addEventListener\('click', onImageContextMenuClick, true\)/);
  assert.match(artifacts.mainWorld, /data-feishu-imgctx-action/);
  assert.match(artifacts.mainWorld, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.doesNotMatch(artifacts.mainWorld, /addEventListener\('scroll', closeImageContextMenu/);
  assert.doesNotMatch(artifacts.mainWorld, /addEventListener\('blur', closeImageContextMenu/);
  assert.match(artifacts.mainWorld, /addEventListener\('wheel', closeImageContextMenu/);
});

test('binary image clipboard writes use whichever extension context currently owns focus', () => {
  assert.match(artifacts.bridge, /function writeImageClipboardFocusedContext/);
  assert.match(artifacts.bridge, /protocol\.MESSAGES\.CLIPBOARD_WRITE/);
  assert.match(artifacts.bridge, /document\.hasFocus\(\)/);
  assert.match(artifacts.serviceWorker, /writeImageClipboardFocusedContext/);
  assert.match(artifacts.popupSource, /MESSAGES.CLIPBOARD_WRITE_TARGET/);
  assert.match(artifacts.popupSource, /document\.hasFocus\(\)/);
  assert.doesNotMatch(artifacts.serviceWorker, /ensureOffscreenClipboardDocument/);
  assert.match(artifacts.bridge, /writeImageBlobPromise\(blobPromise\)/);
  assert.match(artifacts.imageClipboard, /new ClipboardItem\(\{ 'image\/png': pngPromise \}\)/);
  assert.match(artifacts.mainWorld, /return requestTrustedImageAction\('copy', imageInfo\)/);
  assert.match(artifacts.mainWorld, /return requestTrustedImageAction\('download', imageInfo\)/);
  assert.match(artifacts.bridge, /downloadTrustedContextImage\(trustedImage\.blobPromise\)/);
  assert.match(artifacts.bridge, /anchor\.href = objectUrl/);
  assert.doesNotMatch(artifacts.mainWorld, /a\.href = imageInfo\.src/);
  assert.doesNotMatch(artifacts.mainWorld, /return attempt\.then\(writeBlobToClipboard\)/);
});

test('paste flow carries the source document title into the target title slot', () => {
  assert.match(artifacts.mainWorld, /function applyDocumentTitleToCurrentDoc/);
  assert.match(artifacts.mainWorld, /\.wiki-suite-title \.breadcrumb-editable-title/);
  assert.match(artifacts.mainWorld, /contentRoot && contentRoot\.contains\(node\)\) return false/);
  assert.match(artifacts.mainWorld, /waitForDocumentTitleApplied\(cleanTitle, 1200\)/);
  assert.match(artifacts.mainWorld, /titleApplied \? stripTitleFromContent\(pending, pending\.title\) : pending/);
  assert.doesNotMatch(artifacts.mainWorld, /function prependTitleToContent/);
});

test('paste flow carries the source page icon emoji as page metadata', () => {
  assert.match(artifacts.mainWorld, /function extractPageIconEmojiFromDom/);
  assert.match(artifacts.mainWorld, /function applyPageIconEmojiToCurrentDoc/);
  assert.match(artifacts.mainWorld, /em-emoji-picker/);
  assert.match(artifacts.mainWorld, /\.page-block-header \[class\*="doc-custom-icon"\]/);
  assert.match(artifacts.mainWorld, /applyPageIconEmojiToCurrentDoc\(pending\.pageIconEmoji\)/);
  assert.match(artifacts.mainWorld, /cleanupPageIconUi\(\)/);
});

test('paste dispatch does not target an inactive hidden paste textarea', () => {
  assert.match(artifacts.mainWorld, /purpose === 'paste' && el === document\.activeElement \? 1300 : -Infinity/);
  assert.match(artifacts.mainWorld, /includeHiddenTextarea && isHiddenPasteTextarea\(document\.activeElement\)/);
});

test('paste flow focuses the document body after writing the title', () => {
  assert.match(artifacts.mainWorld, /getEditableCandidates\(\{ purpose: 'paste', includeHiddenTextarea: false \}\)/);
  assert.match(artifacts.mainWorld, /\[data-block-type\] \.zone-container\.text-editor\[contenteditable="true"\]/);
  assert.match(artifacts.mainWorld, /root\.matches\('\.zone-container\.text-editor\[contenteditable="true"\]'\)/);
  assert.match(artifacts.mainWorld, /!editor\.closest\('\.page-block-header'\)/);
  assert.match(artifacts.mainWorld, /if \(bodyEditors\.length\) return bodyEditors\[0\]/);
  assert.match(artifacts.mainWorld, /target\.setAttribute\('tabindex', '-1'\)/);
  assert.match(artifacts.mainWorld, /function focusDocumentBodyForPaste/);
  assert.match(artifacts.mainWorld, /function waitForDocumentBodyPasteTarget/);
  assert.match(artifacts.mainWorld, /function activateEmptyDocumentBodyForPaste/);
  assert.match(artifacts.mainWorld, /ready\.rootChildCount !== 0/);
  assert.match(artifacts.mainWorld, /querySelectorAll\('\.first-line-empty'\)/);
  assert.doesNotMatch(artifacts.mainWorld, /node\.querySelector\('\.docx-empty-placeholder'\)/);
  assert.match(artifacts.mainWorld, /node\.closest\('\.editor-container'\)/);
  assert.match(artifacts.mainWorld, /waitForDocumentBodyPasteTarget\(6000\)/);
  assert.match(artifacts.mainWorld, /label: '准备正文'/);
  assert.match(artifacts.mainWorld, /label: '写入正文'/);
  assert.match(artifacts.mainWorld, /目标文档正文编辑器尚未就绪/);
});

test('whiteboard counts appear in card statistics without a duplicate extraction summary', () => {
  assert.match(artifacts.popupSource, /counts\.push\(\[summary\.whiteboardCount, '画板'\]\)/);
  assert.doesNotMatch(artifacts.mainWorld, /'已提取 ' \+ officialBlockCount/);
});

test('image conversion uses the shared concurrency pool and image paste has one registration path', () => {
  assert.match(artifacts.mainWorld, /mapWithConcurrency\(workItems, 5, convertOne\)/);
  assert.match(artifacts.mainWorld, /waitForRegisteredImageInsertion\(clipboardResult\.previousImageIds, 60000\)/);
  assert.doesNotMatch(artifacts.mainWorld, /function uploadAllImages|function startImageInjectionObserver/);
});

test('popup shows counted and indeterminate progress and resumes via the service worker', () => {
  assert.match(artifacts.popupSource, /message\(MESSAGES.PROGRESS_QUERY/);
  assert.match(artifacts.popupSource, /progressRevision/);
  assert.match(artifacts.popupSource, /total \? `\$\{label\} \$\{done\}\/\$\{total\}` : label/);
  assert.match(artifacts.popupCss, /@keyframes progress-indeterminate/);
  assert.doesNotMatch(artifacts.popupSource, /SCENARIOS|fdm:images-extracted|requestAnimationFrame/);
});

test('popup reuses a session snapshot and reads real summaries on refresh', () => {
  assert.match(artifacts.popupSource, /chrome\.storage\.session\.get\(key\)/);
  assert.match(artifacts.popupSource, /chrome\.storage\.session\.set\(/);
  assert.match(artifacts.popupSource, /manual \|\| !saved/);
  assert.match(artifacts.popupSource, /await sendAction\('scan'\)/);
  assert.match(artifacts.popupSource, /Number\.isInteger\(summary\?\.\[key\]\)/);
});

test('embedded charts are captured as structured image fallbacks without changing whiteboard handling', () => {
  assert.match(artifacts.mainWorld, /function captureEmbeddedChartFallbacks/);
  assert.match(artifacts.mainWorld, /function cloneBlockTreeWithEmbeddedChartImages/);
  assert.match(artifacts.mainWorld, /cloneBlockTreeWithWhiteboardMarkers\(renderRoot, whiteboardTransfer\)/);
  assert.match(artifacts.mainWorld, /sourceSummary && sourceSummary\.imageCount/);
  assert.match(artifacts.mainWorld, /内嵌图表已转图片/);
  assert.match(artifacts.mainWorld, /applyBrowserWhiteboards\(transfer\)/);
});

test('runtime loads shared async helpers before both transfer modules', () => {
  const asyncIndex = artifacts.mainWorld.indexOf('function scanVirtualScroller');
  const chartIndex = artifacts.mainWorld.indexOf('function captureEmbeddedChartFallbacks');
  const whiteboardIndex = artifacts.mainWorld.indexOf('function captureBrowserWhiteboards');
  assert.ok(asyncIndex >= 0 && asyncIndex < chartIndex && asyncIndex < whiteboardIndex);
  assert.match(artifacts.mainWorld, /mapWithConcurrency\(imageUrls, 3/);
  assert.match(artifacts.mainWorld, /mapWithConcurrency\(keys, 3/);
  assert.match(artifacts.mainWorld, /firstDelayMs: 110,\s+secondDelayMs: 220/);
});

test('image reconciliation skips only its redundant second text-settling wait', () => {
  assert.match(artifacts.mainWorld, /imageSummary && imageSummary\.imageCount > 0\s+\? true\s+: waitForPasteBodySettled\(pending, 5000\)/);
  assert.match(artifacts.mainWorld, /waitForPasteBodySettled\(pending, 12000\)/);
});

test('target placeholder cleanup starts while the pasted body is still settling', () => {
  assert.match(artifacts.mainWorld, /function waitForPreservedEmptyBodyRecordsRemoval/);
  assert.match(
    artifacts.mainWorld,
    /var earlyEmptyCleanup = waitForPreservedEmptyBodyRecordsRemoval\([\s\S]*?Promise\.all\(\[\s*waitForPasteBodySettled\(pending, 12000\),\s*earlyEmptyCleanup/
  );
  assert.match(artifacts.mainWorld, /removePreservedEmptyBodyRecords\(emptyBodyRecordsBeforePaste\)/);
  const targetReadyIndex = artifacts.mainWorld.indexOf('return waitForDocumentBodyPasteTarget(6000)');
  const captureIndex = artifacts.mainWorld.indexOf(
    'return waitForEmptyBodyRecordsCapture(1200, wasEmptyBodyBeforeFocus)',
    targetReadyIndex
  );
  const commitIndex = artifacts.mainWorld.indexOf('return commitPaste(', captureIndex);
  assert.ok(targetReadyIndex >= 0 && targetReadyIndex < captureIndex && captureIndex < commitIndex);
});

test('browser whiteboard apply relies on node verification without a fixed trailing delay', () => {
  assert.match(artifacts.mainWorld, /function importIntoTargetWhiteboard/);
  assert.match(artifacts.mainWorld, /countState\.count === expectedState\.count/);
  assert.doesNotMatch(artifacts.mainWorld, /setTimeout\(resolve, 1800\)/);
  assert.match(artifacts.mainWorld, /function rollbackBrowserWhiteboardTargets/);
  assert.match(artifacts.mainWorld, /feishu-helper-whiteboard-rollback/);
  assert.match(artifacts.mainWorld, /label: '创建画板'/);
  assert.match(artifacts.mainWorld, /phase: 'whiteboard-load'/);
  assert.match(artifacts.mainWorld, /label: '加载画板'/);
  assert.match(artifacts.mainWorld, /label: '导入画板'/);
});

test('browser whiteboard import binds InsertPage to the newly created target board', () => {
  assert.match(artifacts.mainWorld, /token: target\.targetWhiteboardToken/);
  assert.match(artifacts.mainWorld, /execute\('UnSelectAll', null\)/);
  assert.match(artifacts.mainWorld, /clearTargetWhiteboardSelection\(app\)/);
  assert.doesNotMatch(artifacts.mainWorld, /token: target\.board\.sourceWhiteboardToken/);
});

test('popup keeps the action response authoritative over an early progress done message', () => {
  assert.match(artifacts.popupSource, /state.task = \{ action, local: true \}/);
  assert.match(artifacts.popupSource, /if \(current\?\.local\) return/);
  assert.match(artifacts.popupSource, /result\?\.status !== 'success'/);
  assert.match(artifacts.bridge, /error: protocol\.normalizeProgressLabel\(result && result\.error\)/);
  assert.match(artifacts.bridge, /notice: protocol\.normalizeProgressLabel\(result && result\.notice\)/);
  assert.match(artifacts.popupSource, /await finish\(action, result.notice\)/);
  assert.doesNotMatch(artifacts.popupSource, /notice \|\| summarizeResult\(action, result\)/);
});

test('snapshot scan prefers the document body editor over Feishu page chrome', () => {
  assert.match(artifacts.mainWorld, /function pickDocumentBodyEditor/);
  assert.match(artifacts.mainWorld, /\.zone-container\.text-editor\[contenteditable="true"\]/);
  assert.match(artifacts.mainWorld, /if \(bodyEditor\) return bodyEditor/);
});

test('empty structured documents stay empty instead of falling back to DOM placeholders', () => {
  assert.match(artifacts.mainWorld, /if \(!ss \|\| !ss\.rootBlock\) return extractVisibleDomFallback\(\)/);
  assert.doesNotMatch(artifacts.mainWorld, /if \(!rendered\.blockCount && !finalText && !finalHtml\) \{\n      return extractVisibleDomFallback\(\);\n    \}/);
  assert.doesNotMatch(artifacts.mainWorld, /blockCount: Math\.max\(1, blockCount\)/);
});

test('snapshot scan treats a visibly empty body editor as empty even if struct service is stale', () => {
  assert.match(artifacts.mainWorld, /function isVisibleDocumentBodyEmpty/);
  assert.match(artifacts.mainWorld, /shell\.querySelectorAll\('\.zone-container\.text-editor\[contenteditable="true"\]'\)/);
  assert.match(artifacts.mainWorld, /if \(isVisibleDocumentBodyEmpty\(\)\) \{\n      return \{\n        html: '',\n        text: '',\n        blockCount: 0/);
});

test('snapshot scan does not treat the whole document as empty because one body block is blank', () => {
  assert.match(artifacts.mainWorld, /for \(var i = 0; i < bodyEditors\.length; i\+\+\) \{/);
  assert.match(artifacts.mainWorld, /if \(normalizeVisibleEditorText\(editor\.innerText \|\| editor\.textContent \|\| ''\)\) return false/);
});

test('unsupported whiteboard blocks are skipped instead of pasted as structured docx records', () => {
  assert.match(artifacts.mainWorld, /UNSUPPORTED_NATIVE_BLOCK_TYPES = \{\s+whiteboard: true/);
  assert.match(artifacts.mainWorld, /if \(isUnsupportedNativeBlockType\(snap\.type\)\) return/);
});
