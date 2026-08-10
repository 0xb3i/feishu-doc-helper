const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadPageIconRuntime(document) {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/feishu-runtime/32-page-icon.js'),
    'utf8'
  );
  const context = { document };
  vm.createContext(context);
  vm.runInContext(
    source + '\nthis.__pageIconTestApi = { extractPageIconEmojiFromDom: extractPageIconEmojiFromDom };',
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
