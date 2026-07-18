const test = require('node:test');
const assert = require('node:assert/strict');

const attribs = require('../lib/feishu-attribs.cjs');

test('shared attrib runs preserve bold links and equations in both renderers', () => {
  const pool = {
    0: ['bold', 'true'],
    1: ['link', 'https%3A%2F%2Fexample.com%2Fa'],
    2: ['equation', 'x^2'],
  };

  const runs = attribs.parseFeishuAttribRuns('*0*1+4*2+1', 'Linkx', pool);
  assert.equal(runs.length, 2);
  assert.deepEqual(
    {
      rawText: runs[0].rawText,
      isBold: runs[0].isBold,
      linkHref: runs[0].linkHref,
      equation: runs[1].equationAttr,
    },
    {
      rawText: 'Link',
      isBold: true,
      linkHref: 'https://example.com/a',
      equation: ['equation', 'x^2'],
    }
  );
  assert.equal(
    attribs.decodeFeishuAttribs('*0*1+4*2+1', 'Linkx', pool),
    '[**Link**](https://example.com/a)$x^2$'
  );
  assert.equal(
    attribs.decodeFeishuAttribsToHtml('*0*1+4*2+1', 'Linkx', pool),
    '<a href="https://example.com/a"><strong>Link</strong></a> $$x^2$$ '
  );
});

test('text beyond the attrib stream remains trailing plain text', () => {
  const pool = { 0: ['bold', 'true'] };
  assert.equal(attribs.decodeFeishuAttribs('*0+1', 'abc', pool), '**a**bc');
  assert.equal(attribs.decodeFeishuAttribsToHtml('*0+1', 'abc', pool), '<strong>a</strong>bc');
});

test('HTML color normalization only runs for explicit color attributes', () => {
  function normalizeColor() { return 'red'; }
  assert.equal(
    attribs.decodeFeishuAttribsToHtml('+1', 'x', {}, { normalizeColor: normalizeColor }),
    'x'
  );
  assert.equal(
    attribs.decodeFeishuAttribsToHtml('*0+1', 'x', { 0: ['textHighlight', ''] }, { normalizeColor: normalizeColor }),
    '<span style="color:red;">x</span>'
  );
});

test('malformed percent links stay inert and never break either renderer', () => {
  const pool = { 0: ['link', '%'] };
  assert.equal(attribs.safeDecodeURIComponent('%'), '%');
  assert.equal(attribs.normalizeLinkHref('%'), '');
  assert.doesNotThrow(function () {
    attribs.parseFeishuAttribRuns('*0+1', 'x', pool);
  });
  assert.equal(attribs.decodeFeishuAttribs('*0+1', 'x', pool), 'x');
  assert.equal(attribs.decodeFeishuAttribsToHtml('*0+1', 'x', pool), 'x');
});
