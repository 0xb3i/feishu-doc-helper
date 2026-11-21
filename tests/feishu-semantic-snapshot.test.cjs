const test = require('node:test');
const assert = require('node:assert/strict');
const { createSemanticSnapshotCollector } = require('../lib/feishu-semantic-snapshot.cjs');
const attribs = require('../lib/feishu-attribs.cjs');
const styleCodec = require('../lib/feishu-style-codec.cjs');

const collector = createSemanticSnapshotCollector({ attribs, styleCodec });

test('DOM semantic collection groups callout wrappers by their owning block without merging inline images or equations', () => {
  const callout = { textContent: 'One logical callout' };
  const wrappers = Array.from({ length: 12 }, () => ({
    textContent: 'Nested wrapper',
    closest(selector) {
      assert.equal(selector, '[data-block-type="callout"]');
      return callout;
    },
  }));
  const images = [1, 2].map((index) => ({ alt: 'Image ' + index, width: 100, height: 100 }));
  const equations = ['x^2', 'y^2'].map((latex) => ({ getAttribute: () => latex }));
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('callout')) return wrappers;
      if (selector.includes('img')) return images;
      if (selector.startsWith('math,')) return equations;
      return [];
    },
  };
  const snapshot = collector.collectFromDom(root);
  assert.deepEqual(snapshot.componentCounts, { image: 2, callout: 1, equation: 2 });
  assert.equal(snapshot.components.find((component) => component.type === 'callout').textSample, 'One logical callout');
});

test('structured counts and samples win over duplicate DOM wrappers while missing types still receive DOM samples', () => {
  const primary = {
    componentCounts: { callout: 1, image: 50 },
    components: [{ type: 'callout', textSample: 'Structured callout', rendered: true }],
  };
  const fallback = {
    componentCounts: { callout: 12, image: 2, equation: 2 },
    components: [
      ...Array.from({ length: 12 }, () => ({ type: 'callout', textSample: 'DOM wrapper' })),
      { type: 'image' }, { type: 'image' },
      { type: 'equation', textSample: 'x^2' }, { type: 'equation', textSample: 'y^2' },
    ],
  };
  const merged = collector.mergeSemanticSnapshots(primary, fallback);
  assert.deepEqual(merged.componentCounts, { callout: 1, equation: 2, image: 50 });
  assert.equal(merged.totalComponentCount, 53);
  assert.equal(merged.components.filter((component) => component.type === 'callout').length, 1);
  assert.equal(merged.components[0].textSample, 'Structured callout');
  assert.equal(merged.components.filter((component) => component.type === 'equation').length, 2);
});
