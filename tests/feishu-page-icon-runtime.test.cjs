const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadPageIconRuntime(document, overrides = {}) {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/32-page-icon.js'),
    'utf8'
  );
  const context = {
    document,
    attribs: {
      normalizePlainText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      },
    },
    getContentRootElement() { return null; },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(
    source + '\nthis.__pageIconTestApi = {'
      + ' extractPageIconEmojiFromDom: extractPageIconEmojiFromDom,'
      + ' getCurrentBodyTextForPasteStability: getCurrentBodyTextForPasteStability'
      + ' };',
    context,
    { filename: '32-page-icon.js' }
  );
  return context.__pageIconTestApi;
}

test('page icon extraction ignores wiki ancestor breadcrumb icons', () => {
  const breadcrumbIcon = { innerText: '🎯', textContent: '🎯' };
  const api = loadPageIconRuntime({
    querySelectorAll(selector) {
      return selector.includes('wiki-suite-title') ? [breadcrumbIcon] : [];
    },
  });

  assert.equal(api.extractPageIconEmojiFromDom(), '');
});

test('page icon extraction reads only the current page header icon', () => {
  const pageIcon = { innerText: '📘', textContent: '📘' };
  const api = loadPageIconRuntime({
    querySelectorAll(selector) {
      return selector.startsWith('.page-block-header__custom_icon') ? [pageIcon] : [];
    },
  });

  assert.equal(api.extractPageIconEmojiFromDom(), '📘');
});

test('paste stability aggregates short body editors instead of sampling one block', () => {
  const editors = [
    { innerText: '第一段很短，但它只是完整正文的一部分。'.repeat(2) },
    { innerText: '第二段同样很短，合并后应超过稳定阈值。'.repeat(2) },
  ];
  const shell = { querySelectorAll() { return editors; } };
  const api = loadPageIconRuntime({
    querySelector() { return shell; },
    querySelectorAll() { return []; },
  });

  const text = api.getCurrentBodyTextForPasteStability();
  assert.match(text, /第一段很短/);
  assert.match(text, /第二段同样很短/);
  assert.ok(text.length > editors[0].innerText.length);
});
