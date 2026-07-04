#!/usr/bin/env node
'use strict';

// Build helper for the Feishu browser extension (Manifest V3).
//
// The extension is fully self-contained.  Maintainable sources live in
// `lib/feishu-*.cjs` (pure helpers) and `src/feishu-runtime/*` (page runtime);
// this script inlines them into a single MAIN-world content script and wires
// up the popup build via Vite.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/feishu-extension');
const MATCHES = [
  'https://*.feishu.cn/*',
  'https://*.larksuite.com/*',
  'https://*.larkoffice.com/*',
];

// 图片 CDN 域：service worker 需要对这些域有 host 权限，才能跨域抓取图片字节
// （绕开页面 CORS，模拟浏览器原生"复制图片"的行为）。不注入内容脚本。
const IMAGE_HOSTS = [
  'https://*.feishucdn.com/*',
  'https://*.feishu.cn/*',
  'https://*.larksuitecdn.com/*',
  'https://*.larksuite.com/*',
  'https://*.larkoffice.com/*',
  'https://*.bytedance.net/*',
  'https://*.byteimg.com/*',
];

// Pure helper modules (CommonJS) shared by the page runtime.  Each must end
// with a `module.exports` assignment; they are exposed to the runtime through
// the `FeishuHelperLibs` container.
const LIB_MODULES = [
  'lib/feishu-attribs.cjs',
  'lib/feishu-style-codec.cjs',
  'lib/feishu-html-sanitizer.cjs',
  'lib/feishu-docx-record.cjs',
  'lib/feishu-block-render.cjs',
  'lib/feishu-semantic-snapshot.cjs',
];

// Page runtime parts, concatenated in order to form the MAIN-world script.
const RUNTIME_PARTS = [
  'src/feishu-runtime/00-bootstrap.js',
  'src/feishu-runtime/10-editor-storage.js',
  'src/feishu-runtime/20-images.js',
  'src/feishu-runtime/30-extraction-clipboard-paste.js',
  'src/feishu-runtime/40-image-panel-context-menu.js',
  'src/feishu-runtime/50-automation-whiteboard.js',
];

function moduleNameFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/^feishu-/, '')
    .replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
}

function indentSource(source, spaces) {
  const indent = ' '.repeat(spaces);
  return source.split('\n').map(function (line) {
    return line ? indent + line : line;
  }).join('\n');
}

// Wrap each CJS lib so its `module.exports` is exposed via FeishuHelperLibs.
function inlineLibSources() {
  const wrappers = LIB_MODULES.map(function (relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    const moduleName = moduleNameFromPath(relativePath);
    return [
      '  // ── ' + relativePath + ' ──',
      '  FeishuHelperLibs.' + moduleName + ' = (function () {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
      '    (function () {',
      indentSource(source, 6),
      '    })();',
      '    return module.exports;',
      '  })();',
    ].join('\n');
  });

  return [
    '  var FeishuHelperLibs = {};',
    wrappers.join('\n\n'),
  ].join('\n');
}

function inlineRuntimeSources() {
  return RUNTIME_PARTS.map(function (relativePath) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\s+$/, '');
    return [
      '  // ── ' + relativePath + ' ──',
      source,
    ].join('\n');
  }).join('\n\n');
}

function copyFile(relativePath, targetRelativePath) {
  const source = path.join(ROOT, relativePath);
  const target = path.join(DIST, targetRelativePath || relativePath.replace(/^extension\//, ''));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeJson(relativePath, value) {
  const target = path.join(DIST, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function buildMainWorldScript() {
  return [
    '(function () {',
    "  'use strict';",
    '',
    "  if (window.__feishuHelperRuntime && typeof window.__feishuHelperRuntime.dispose === 'function') {",
    "    try { window.__feishuHelperRuntime.dispose(); }",
    "    catch (error) { console.warn('[Feishu Helper] previous runtime dispose failed', error); }",
    '  }',
    '',
    inlineLibSources(),
    '',
    inlineRuntimeSources(),
    '',
    '})();',
    '',
  ].join('\n');
}

function buildManifest(packageJson) {
  return {
    manifest_version: 3,
    name: '飞书文档助手',
    version: String(packageJson.version || '1.0.0'),
    description: '飞书文档复制、粘贴与图片提取菜单',
    permissions: ['storage', 'contextMenus', 'commands'],
    host_permissions: MATCHES.concat(IMAGE_HOSTS),
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '飞书文档助手',
      default_popup: 'ui/popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    background: {
      service_worker: 'background/service-worker.js',
    },
    content_scripts: [
      {
        matches: MATCHES,
        js: ['content/main-world.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: MATCHES,
        js: ['content/bridge.js'],
        run_at: 'document_start',
      },
    ],
    commands: {
      'feishu-extract': {
        suggested_key: { default: 'Ctrl+Shift+D', mac: 'Command+Shift+D' },
        description: '提取当前飞书文档',
      },
      'feishu-paste': {
        suggested_key: { default: 'Ctrl+Shift+P', mac: 'Command+Shift+P' },
        description: '粘贴已提取的飞书文档副本',
      },
      'feishu-snapshot': {
        description: '刷新飞书文档页面快照',
      },
    },
  };
}

function runViteBuild() {
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const result = spawnSync(process.execPath, [
    viteBin,
    'build',
    '--config',
    path.join(ROOT, 'extension/vite.config.mjs'),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stdout || '') + (result.stderr || ''));
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function build() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'content'), { recursive: true });

  writeJson('manifest.json', buildManifest(packageJson));
  fs.writeFileSync(path.join(DIST, 'content/main-world.js'), buildMainWorldScript());
  copyFile('extension/content/bridge.js', 'content/bridge.js');
  copyFile('extension/background/service-worker.js', 'background/service-worker.js');
  ['16', '32', '48', '128'].forEach(function (size) {
    copyFile('extension/icons/icon-' + size + '.png', 'icons/icon-' + size + '.png');
  });
  runViteBuild();
  console.log('[build-feishu-extension] wrote ' + path.relative(ROOT, DIST));
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error('[build-feishu-extension] failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  build: build,
  buildMainWorldScript: buildMainWorldScript,
  buildManifest: buildManifest,
};
