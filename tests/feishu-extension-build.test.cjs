const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/feishu-extension');

test('build:feishu:extension emits a loadable MV3 extension with a popup dashboard menu', () => {
  fs.rmSync(DIST, { recursive: true, force: true });

  const result = spawnSync('npm', ['run', 'build:feishu:extension'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, '飞书文档助手');
  assert.equal(manifest.action.default_popup, 'ui/popup.html');
  assert.equal(manifest.side_panel, undefined);
  assert.deepEqual(manifest.permissions.sort(), ['commands', 'contextMenus', 'storage'].sort());
  assert.ok(manifest.host_permissions.includes('https://*.feishu.cn/*'));
  assert.ok(manifest.host_permissions.includes('https://*.larksuite.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.larkoffice.com/*'));

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

  [
    'content/main-world.js',
    'content/bridge.js',
    'background/service-worker.js',
    'ui/popup.html',
    'ui/assets/popup.js',
    'ui/assets/popup.css',
  ].forEach(function (relativePath) {
    assert.ok(fs.existsSync(path.join(DIST, relativePath)), relativePath + ' should exist');
  });

  const popupJs = fs.readFileSync(path.join(DIST, 'ui/assets/popup.js'), 'utf8');
  const popupCss = fs.readFileSync(path.join(DIST, 'ui/assets/popup.css'), 'utf8');
  const popupSource = fs.readFileSync(path.join(ROOT, 'extension/ui/popup.jsx'), 'utf8');
  assert.match(popupJs, /FEISHU_EXTENSION_UI/);
  [
    'popup',
    'doc-card',
    'status-tag',
    'statistic',
    'action-grid',
    'ant-btn',
    'alert',
  ].forEach(function (className) {
    assert.ok(popupSource.includes(className), className + ' should be used by the popup');
    assert.ok(popupCss.includes('.' + className), className + ' should be styled by the popup');
  });
  assert.doesNotMatch(popupSource, /from ['"]antd['"]/);
  assert.doesNotMatch(popupSource, /@ant-design\/icons/);
  assert.doesNotMatch(popupSource, /mode-switch/);
  assert.doesNotMatch(popupSource, /activeKey/);
  assert.doesNotMatch(popupSource, /diagnosticsItems/);
  assert.doesNotMatch(popupSource, /primary-flow-card/);
  assert.doesNotMatch(popupSource, /action-board/);
  assert.doesNotMatch(popupCss, /100dvh/);
  assert.doesNotMatch(popupJs, /from ['"]antd['"]/);
  assert.doesNotMatch(manifest.name, /ant/i);
  assert.doesNotMatch(JSON.stringify(manifest), /sidepanel|side_panel|sidePanel/);
});

test('extension bridge exposes first-class UI actions instead of simulating shortcuts', () => {
  fs.rmSync(DIST, { recursive: true, force: true });
  const result = spawnSync('npm', ['run', 'build:feishu:extension'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const mainWorld = fs.readFileSync(path.join(DIST, 'content/main-world.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(DIST, 'content/bridge.js'), 'utf8');
  const popup = fs.readFileSync(path.join(DIST, 'ui/assets/popup.js'), 'utf8');

  assert.match(mainWorld, /feishu-helper:ui-action/);
  assert.match(mainWorld, /pasteIntoDoc\(\)/);
  assert.match(mainWorld, /duplicateDocumentForAutomation\(\)/);
  assert.match(bridge, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(bridge, /document\.dispatchEvent\(new CustomEvent\('feishu-helper:ui-action'/);
  assert.match(popup, /FEISHU_EXTENSION_UI/);
});
