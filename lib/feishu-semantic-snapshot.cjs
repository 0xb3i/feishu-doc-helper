'use strict';

// Build the semantic snapshot for the extension runtime.  The runtime writes
// two JSON DOM attributes (`data-feishu-extraction-result` and
// `data-feishu-validation-snapshot`) that include a `semanticSnapshot` field
// with the shape this module produces.

function createSemanticSnapshotCollector(deps) {
  var attribs = deps.attribs;
  var styleCodec = deps.styleCodec;
  var renderer = deps.renderer;

  var MAX_BLOCK_DEPTH = 12;
  var MAX_STORED_COMPONENTS = 40;
  var NON_TEXT_COMPONENT_TYPE_MAP = {
    image: 'image',
    callout: 'callout',
    quote_container: 'quote',
    code: 'code_block',
    divider: 'divider',
    grid: 'grid',
    table: 'table',
    bookmark: 'bookmark',
    diagram: 'diagram',
    whiteboard: 'whiteboard',
    synced_reference: 'synced_reference',
  };

  function summarizeComponentText(text, limit) {
    var normalized = attribs.normalizePlainText(String(text || ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';
    return normalized.slice(0, limit || 120);
  }

  function createSemanticSnapshot() {
    return {
      componentCounts: {},
      components: [],
      totalComponentCount: 0,
      storedComponentCount: 0,
    };
  }

  function pushSemanticComponent(snapshot, component) {
    if (!snapshot || !component || !component.type) return;
    var type = String(component.type || '');
    snapshot.componentCounts[type] = (snapshot.componentCounts[type] || 0) + 1;
    snapshot.totalComponentCount += 1;
    if (snapshot.components.length >= MAX_STORED_COMPONENTS) return;
    snapshot.components.push(component);
    snapshot.storedComponentCount = snapshot.components.length;
  }

  function listSemanticComponentsByType(snapshot, type) {
    if (!snapshot || !Array.isArray(snapshot.components)) return [];
    return snapshot.components.filter(function (component) {
      return component && component.type === type;
    });
  }

  function scoreSemanticComponent(component) {
    if (!component) return 0;
    var score = 0;
    if (component.rendered === true) score += 2;
    if (component.textSample) score += Math.min(String(component.textSample).length, 80) / 20;
    if (Number(component.width || 0) > 0) score += 1;
    if (Number(component.height || 0) > 0) score += 1;
    if (Number(component.rowCount || 0) > 0) score += 1;
    if (Number(component.colCount || 0) > 0) score += 1;
    if (Array.isArray(component.cellTexts) && component.cellTexts.length) {
      score += Math.min(component.cellTexts.length, 4);
    }
    return score;
  }

  function scoreSemanticComponentList(components) {
    return (components || []).reduce(function (total, component) {
      return total + scoreSemanticComponent(component);
    }, 0);
  }

  function chooseSemanticComponentsForType(primaryComponents, fallbackComponents) {
    if ((fallbackComponents || []).length > (primaryComponents || []).length) {
      return fallbackComponents || [];
    }
    if ((primaryComponents || []).length > (fallbackComponents || []).length) {
      return primaryComponents || [];
    }
    return scoreSemanticComponentList(fallbackComponents || []) > scoreSemanticComponentList(primaryComponents || [])
      ? (fallbackComponents || [])
      : (primaryComponents || []);
  }

  function mergeSemanticSnapshots(primarySnapshot, fallbackSnapshot) {
    var primary = primarySnapshot || createSemanticSnapshot();
    var fallback = fallbackSnapshot || createSemanticSnapshot();
    var result = createSemanticSnapshot();
    var typeMap = {};

    Object.keys(primary.componentCounts || {}).forEach(function (type) { typeMap[type] = true; });
    Object.keys(fallback.componentCounts || {}).forEach(function (type) { typeMap[type] = true; });
    (primary.components || []).forEach(function (c) { if (c && c.type) typeMap[c.type] = true; });
    (fallback.components || []).forEach(function (c) { if (c && c.type) typeMap[c.type] = true; });

    var stored = [];
    Object.keys(typeMap).sort().forEach(function (type) {
      var primaryComponents = listSemanticComponentsByType(primary, type);
      var fallbackComponents = listSemanticComponentsByType(fallback, type);
      var resolvedCount = Math.max(
        Number(primary.componentCounts && primary.componentCounts[type] || 0),
        Number(fallback.componentCounts && fallback.componentCounts[type] || 0),
        primaryComponents.length,
        fallbackComponents.length
      );
      if (resolvedCount <= 0) return;
      result.componentCounts[type] = resolvedCount;
      result.totalComponentCount += resolvedCount;
      chooseSemanticComponentsForType(primaryComponents, fallbackComponents).forEach(function (component) {
        if (stored.length >= MAX_STORED_COMPONENTS) return;
        stored.push(component);
      });
    });

    result.components = stored;
    result.storedComponentCount = stored.length;
    return result;
  }

  function collectEquationComponentsFromText(text) {
    var components = [];
    attribs.splitLatexSegments(text).forEach(function (segment) {
      if (!segment || segment.type !== 'formula' || !segment.value) return;
      components.push({
        type: 'equation',
        textSample: summarizeComponentText(segment.value, 160),
        rendered: true,
      });
    });
    return components;
  }

  function collectBlockPlainText(block, depth) {
    if (!block || depth > MAX_BLOCK_DEPTH || !block.record || !block.record.snapshot) return '';
    var parts = [];
    var snap = block.record.snapshot;
    var text = attribs.decodeBlockText(snap);
    if (text) parts.push(text);
    renderer.getBlockChildren(block).forEach(function (child) {
      var childText = collectBlockPlainText(child, depth + 1);
      if (childText) parts.push(childText);
    });
    return parts.join('\n');
  }

  function buildRenderedImageSummary(image, getDocument) {
    var token = image && image.token ? String(image.token) : '';
    var node = null;
    if (typeof getDocument === 'function') {
      var doc = getDocument();
      if (doc) {
        try {
          var selector = token ? 'img[src*="' + token.replace(/["\\]/g, '\\$&') + '"]' : 'img';
          node = doc.querySelector(selector);
        } catch (err) { node = null; }
      }
    }
    var width = node ? Number(node.naturalWidth || node.width || 0) : Number((image && image.width) || 0);
    var height = node ? Number(node.naturalHeight || node.height || 0) : Number((image && image.height) || 0);
    return {
      rendered: width > 0 && height > 0,
      width: width,
      height: height,
    };
  }

  function collectFromStructService(rootBlock, options) {
    var summary = createSemanticSnapshot();
    if (!rootBlock) return summary;
    var opts = options || {};
    var getDocument = opts.getDocument || function () {
      return typeof document !== 'undefined' ? document : null;
    };
    var resolveCalloutStyle = typeof opts.calloutStyleResolver === 'function'
      ? opts.calloutStyleResolver
      : function () { return { background_color: '', border_color: '' }; };

    function walk(block, depth) {
      if (!block || depth > MAX_BLOCK_DEPTH || !block.record || !block.record.snapshot) return;
      var snap = block.record.snapshot;
      var rawType = String(snap.type || '');
      var componentType = NON_TEXT_COMPONENT_TYPE_MAP[rawType] || '';

      if (rawType === 'page') {
        renderer.getBlockChildren(block).forEach(function (child) { walk(child, depth + 1); });
        return;
      }

      if (rawType === 'callout' && !snap.background_color) {
        var domStyle = resolveCalloutStyle(block.record.id);
        if (domStyle.background_color) snap.background_color = domStyle.background_color;
        if (domStyle.border_color) snap.border_color = domStyle.border_color;
      }

      if (componentType === 'image') {
        var imageRender = buildRenderedImageSummary(snap.image || {}, getDocument);
        pushSemanticComponent(summary, {
          type: 'image',
          textSample: summarizeComponentText((snap.image && snap.image.name) || '', 80),
          rendered: imageRender.rendered,
          width: imageRender.width,
          height: imageRender.height,
        });
      } else if (componentType === 'table') {
        var matrix = renderer.buildTableMatrix(snap, block, attribs.decodeBlockText, function (parts) {
          return parts.join(' ').replace(/\s+/g, ' ').trim();
        });
        var cellTexts = [];
        if (matrix && matrix.rows) {
          matrix.rows.forEach(function (row) {
            row.forEach(function (cell) {
              var normalized = summarizeComponentText(cell, 80);
              if (normalized) cellTexts.push(normalized);
            });
          });
        }
        pushSemanticComponent(summary, {
          type: 'table',
          rendered: true,
          rowCount: matrix && matrix.rows ? matrix.rows.length : 0,
          colCount: matrix && matrix.cols ? matrix.cols.length : 0,
          cellTexts: cellTexts.slice(0, 6),
          textSample: cellTexts[0] || '',
        });
      } else if (componentType === 'callout') {
        pushSemanticComponent(summary, {
          type: 'callout',
          rendered: true,
          textSample: summarizeComponentText(styleCodec.selectPrimaryCalloutContent(
            attribs.decodeBlockText(snap),
            collectBlockPlainText(block, depth + 1)
          ), 160),
        });
      } else if (componentType === 'quote') {
        pushSemanticComponent(summary, {
          type: 'quote',
          rendered: true,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      } else if (componentType === 'code_block') {
        pushSemanticComponent(summary, {
          type: 'code_block',
          rendered: true,
          textSample: summarizeComponentText(attribs.decodeBlockText(snap), 160),
        });
      } else if (componentType === 'divider') {
        pushSemanticComponent(summary, {
          type: 'divider',
          rendered: true,
          textSample: '',
        });
      } else if (componentType === 'grid') {
        var columnCount = renderer.getBlockChildren(block).filter(function (child) {
          return child && child.record && child.record.snapshot && child.record.snapshot.type === 'grid_column';
        }).length;
        pushSemanticComponent(summary, {
          type: 'grid',
          rendered: true,
          colCount: columnCount,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      } else if (componentType) {
        pushSemanticComponent(summary, {
          type: componentType,
          rendered: true,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      }

      collectEquationComponentsFromText(attribs.decodeBlockText(snap)).forEach(function (component) {
        pushSemanticComponent(summary, component);
      });

      renderer.getBlockChildren(block).forEach(function (child) { walk(child, depth + 1); });
    }

    walk(rootBlock, 0);
    return summary;
  }

  function collectUniqueElements(root, selectors, limit) {
    var seen = [];
    var nodes = [];
    if (!root || typeof root.querySelectorAll !== 'function') return nodes;
    var cap = limit || 12;
    (selectors || []).forEach(function (selector) {
      if (nodes.length >= cap) return;
      try {
        Array.prototype.slice.call(root.querySelectorAll(selector), 0, cap).forEach(function (node) {
          if (!node || seen.indexOf(node) !== -1 || nodes.length >= cap) return;
          seen.push(node);
          nodes.push(node);
        });
      } catch (error) {}
    });
    return nodes;
  }

  function collectLiteralPlaceholderElements(root, labels, limit) {
    var results = [];
    if (!root || typeof root.querySelectorAll !== 'function') return results;
    var cap = limit || 8;
    Array.prototype.slice.call(root.querySelectorAll('*'), 0, 240).forEach(function (node) {
      if (results.length >= cap) return;
      var text = summarizeComponentText(node.textContent || '', 40);
      if (!text) return;
      if ((labels || []).some(function (label) {
        return text === label || text === '[' + label + ']';
      })) {
        results.push(node);
      }
    });
    return results;
  }

  function collectFromDom(root) {
    var summary = createSemanticSnapshot();
    if (!root) return summary;

    collectUniqueElements(root, [
      'figure.docx-image-block img',
      '[data-block-type="image"] img',
      'img',
    ], 12).forEach(function (img) {
      pushSemanticComponent(summary, {
        type: 'image',
        rendered: Number(img.naturalWidth || img.width || 0) > 0 && Number(img.naturalHeight || img.height || 0) > 0,
        width: Number(img.naturalWidth || img.width || 0),
        height: Number(img.naturalHeight || img.height || 0),
        textSample: summarizeComponentText(img.alt || '', 80),
      });
    });

    collectUniqueElements(root, [
      '[data-block-type="table"] table',
      'table',
    ], 8).forEach(function (table) {
      var rows = Array.from(table.querySelectorAll('tr'));
      var firstRow = rows[0] ? Array.from(rows[0].querySelectorAll('th,td')) : [];
      var cellTexts = Array.from(table.querySelectorAll('th,td')).map(function (cell) {
        return summarizeComponentText(cell.textContent || '', 80);
      }).filter(Boolean).slice(0, 6);
      pushSemanticComponent(summary, {
        type: 'table',
        rendered: true,
        rowCount: rows.length,
        colCount: firstRow.length,
        cellTexts: cellTexts,
        textSample: cellTexts[0] || '',
      });
    });

    collectUniqueElements(root, [
      '.zoneType-calloutBlock',
      '.callout-container',
      '.callout-block',
      '[class*="callout"]',
      '[data-block-type="callout"]',
    ], 12).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'callout',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    Array.prototype.slice.call(root.querySelectorAll('blockquote'), 0, 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'quote',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    collectUniqueElements(root, [
      'pre',
      '[data-block-type="code"]',
      '[class*="code-block"]',
      '[class*="CodeBlock"]',
    ], 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'code_block',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    Array.prototype.slice.call(root.querySelectorAll('hr'), 0, 8).forEach(function () {
      pushSemanticComponent(summary, {
        type: 'divider',
        rendered: true,
        textSample: '',
      });
    });

    Array.prototype.slice.call(
      root.querySelectorAll('math, mjx-container, [data-latex], .katex, [class*="equation"], [class*="formula"]'),
      0,
      12
    ).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'equation',
        rendered: true,
        textSample: summarizeComponentText(
          node.getAttribute('data-latex') || node.textContent || '',
          160
        ),
      });
    });

    collectUniqueElements(root, [
      '[data-block-type="whiteboard"]',
      '[class*="whiteboard"]',
      '[aria-label*="白板"]',
      '[aria-label*="whiteboard"]',
    ], 8).concat(
      collectLiteralPlaceholderElements(root, ['白板'], 8)
    ).slice(0, 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'whiteboard',
        rendered: true,
        textSample: summarizeComponentText(
          node.textContent || (node.getAttribute && node.getAttribute('aria-label')) || '白板',
          80
        ),
      });
    });

    return summary;
  }

  return {
    collectFromDom: collectFromDom,
    collectFromStructService: collectFromStructService,
    createSemanticSnapshot: createSemanticSnapshot,
    listSemanticComponentsByType: listSemanticComponentsByType,
    mergeSemanticSnapshots: mergeSemanticSnapshots,
    pushSemanticComponent: pushSemanticComponent,
  };
}

module.exports = {
  createSemanticSnapshotCollector: createSemanticSnapshotCollector,
};
