const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/feishu-extension');
const PACKAGE_VERSION = require('../package.json').version;

function runExtensionBuild() {
  return spawnSync('npm', ['run', 'build:feishu:extension'], {
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
  artifacts.serviceWorker = fs.readFileSync(path.join(DIST, 'background/service-worker.js'), 'utf8');
  artifacts.popupHtml = fs.readFileSync(path.join(DIST, 'ui/popup.html'), 'utf8');
  artifacts.popupJs = fs.readFileSync(path.join(DIST, 'ui/assets/popup.js'), 'utf8');
  artifacts.popupCss = fs.readFileSync(path.join(DIST, 'ui/assets/popup.css'), 'utf8');
  artifacts.popupSource = fs.readFileSync(path.join(ROOT, 'extension/ui/popup.jsx'), 'utf8');
});

test('build:feishu:extension emits a loadable MV3 extension with a popup dashboard menu', () => {
  const manifest = artifacts.manifest;
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.equal(manifest.version, PACKAGE_VERSION);
  assert.equal(manifest.name, '飞书文档助手');
  assert.equal(manifest.action.default_popup, 'ui/popup.html');
  assert.equal(manifest.side_panel, undefined);
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'commands', 'contextMenus', 'storage', 'unlimitedStorage'].sort());
  assert.ok(manifest.host_permissions.includes('https://*.feishu.cn/docx/*'));
  assert.ok(manifest.host_permissions.includes('https://*.larksuite.com/wiki/*'));
  assert.ok(manifest.host_permissions.includes('https://*.feishucdn.com/*'));
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
  assert.deepEqual(isolatedScripts, ['shared/protocol.js', 'content/bridge.js']);

  [
    'content/main-world.js',
    'content/bridge.js',
    'shared/protocol.js',
    'background/service-worker.js',
    'ui/popup.html',
    'ui/assets/popup.js',
    'ui/assets/popup.css',
  ].forEach(function (relativePath) {
    assert.ok(fs.existsSync(path.join(DIST, relativePath)), relativePath + ' should exist');
  });

  assert.match(artifacts.popupHtml, /assets\/popup\.js/);
  assert.match(artifacts.popupHtml, /assets\/popup\.css/);
  ['提取文档', '粘贴副本', '图片', '快照'].forEach(function (label) {
    assert.ok(artifacts.popupJs.includes(label), label + ' should be rendered by the popup');
  });
  assert.ok(artifacts.popupCss.length > 0, 'popup stylesheet should not be empty');
  assert.doesNotMatch(manifest.name, /ant/i);
  assert.doesNotMatch(JSON.stringify(manifest), /sidepanel|side_panel|sidePanel/);
  assert.match(artifacts.mainWorld, new RegExp("var SCRIPT_VERSION = '" + PACKAGE_VERSION.replace(/\./g, '\\.') + "'"));
  assert.doesNotMatch(artifacts.mainWorld, /__FEISHU_HELPER_VERSION__/);
});

test('extension build auto-reloads the unpacked browser extension when available', () => {
  const buildScript = fs.readFileSync(path.join(ROOT, 'bin/build-feishu-extension.cjs'), 'utf8');
  const reloadScript = fs.readFileSync(path.join(ROOT, 'bin/reload-feishu-extension.cjs'), 'utf8');

  assert.match(buildScript, /FEISHU_EXTENSION_SKIP_RELOAD/);
  assert.match(buildScript, /reload-feishu-extension\.cjs/);
  assert.match(reloadScript, /chrome\.runtime\.reload\(\)/);
  assert.match(reloadScript, /chrome:\/\/extensions/);
});

test('extension bridge exposes first-class UI actions instead of simulating shortcuts', () => {
  assert.match(artifacts.mainWorld, /feishu-helper:ui-action/);
  assert.match(artifacts.bridge, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(artifacts.bridge, /protocol\.DOM_EVENTS\.UI_ACTION/);
  assert.match(artifacts.popupJs, /FEISHU_EXTENSION_UI/);
});

test('pending paste is shared through extension storage and missing cache fails visibly', () => {
  assert.match(artifacts.mainWorld, /feishu-helper:pending-paste/);
  assert.match(artifacts.mainWorld, /请先在源文档按 Cmd\+Shift\+D 提取/);
  assert.match(artifacts.bridge, /protocol\.MESSAGES\.PENDING_PASTE/);
  assert.match(artifacts.serviceWorker, /feishu-pending-paste/);
});

test('image metrics use the same docx record source as paste payloads', () => {
  assert.match(artifacts.mainWorld, /buildImageEntriesFromDocxRecord\(content\.docxRecord\)/);
  assert.match(artifacts.mainWorld, /imageCount: countExtractedImages\(content\)/);
  assert.doesNotMatch(artifacts.mainWorld, /function extractDomImages/);
  assert.doesNotMatch(artifacts.mainWorld, /document\.querySelectorAll\('img'\)\.forEach/);
  assert.doesNotMatch(artifacts.mainWorld, /document\.querySelectorAll\('\[style\*="background-image"\]'\)\.forEach/);
});

test('image right-click is suppressed in the isolated bridge before Feishu handlers', () => {
  assert.match(artifacts.bridge, /window\.addEventListener\(type, suppressFeishuImageRightButton, true\)/);
  assert.match(artifacts.bridge, /event\.stopImmediatePropagation\(\)/);
  assert.match(artifacts.bridge, /\[data-block-type="image"\]/);
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
  assert.match(artifacts.mainWorld, /pageIconEmoji: String\(pending\.pageIconEmoji \|\| ''\)/);
  assert.match(artifacts.mainWorld, /applyPageIconEmojiToCurrentDoc\(pending\.pageIconEmoji\)/);
  assert.match(artifacts.mainWorld, /cleanupPageIconUi\(\)/);
});

test('paste dispatch does not target an inactive hidden paste textarea', () => {
  assert.match(artifacts.mainWorld, /purpose === 'paste' && el === document\.activeElement \? 1300 : -Infinity/);
  assert.match(artifacts.mainWorld, /includeHiddenTextarea && isHiddenPasteTextarea\(document\.activeElement\)/);
});

test('paste flow focuses the document body after writing the title', () => {
  assert.match(artifacts.mainWorld, /getEditableCandidates\(\{ purpose: 'paste', includeHiddenTextarea: false \}\)/);
  assert.match(artifacts.mainWorld, /function focusDocumentBodyForPaste/);
  assert.match(artifacts.mainWorld, /if \(!focusDocumentBodyForPaste\(\)\) restoreCurrentSelection\(savedSelection\)/);
});

test('image upload uses bounded parallelism instead of one-by-one serial upload', () => {
  assert.match(artifacts.mainWorld, /var concurrency = Math\.min\(4, images\.length\)/);
  assert.match(artifacts.mainWorld, /return Promise\.all\(workers\)\.then/);
});

test('image conversion also uses bounded parallelism', () => {
  assert.match(artifacts.mainWorld, /function convertImagesToBase64/);
  assert.match(artifacts.mainWorld, /var concurrency = Math\.min\(5, imgUrls\.length\)/);
  assert.match(artifacts.mainWorld, /return Promise\.all\(workers\)\.then/);
});

test('popup does not render a progress bar for action start messages without totals', () => {
  assert.match(artifacts.popupSource, /if \(message\.state === 'start' \|\| total <= 0\) return/);
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
