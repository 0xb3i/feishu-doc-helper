'use strict';

const crypto = require('node:crypto');

const BUNDLE_SCHEMA_VERSION = 1;
const BUNDLE_TTL_MS = 60 * 60 * 1000;
const MAX_BOARDS = 100;
const MAX_NODES = 20000;
const MAX_NODE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_NODE_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 500;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_BUNDLE_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_XML_DEPTH = 64;
const MAX_XML_ELEMENTS = 100000;
const BUNDLE_ID_RE = /^[a-f0-9]{64}$/;
const SLOT_ID_RE = /^board-[0-9]{4}$/;
const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const RESOURCE_TOKEN_RE = /^[A-Za-z0-9_-]{1,1024}$/;
const MARKER_RE = /^\[\[FEISHU_HELPER_WHITEBOARD:([a-f0-9]{64}):(board-[0-9]{4})\]\]$/;
const OWNERSHIP_NONCE_RE = /^[a-f0-9]{32}$/;
const OWNERSHIP_MARKER_RE = /^\[\[FEISHU_HELPER_WHITEBOARD_OWNERSHIP:([a-f0-9]{64}):(board-[0-9]{4}):([a-f0-9]{32})\]\]$/;
const DOCUMENT_PATH_RE = /^\/(?:docx|docs?|wiki)\/[A-Za-z0-9_-]+(?:[/?#]|$)/i;
const DOCUMENT_HOST_SUFFIXES = ['feishu.cn', 'larksuite.com', 'larkoffice.com'];

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

function hostMatchesSuffix(hostname, suffix) {
  const host = String(hostname || '').toLowerCase();
  const expected = String(suffix || '').toLowerCase();
  return host === expected || host.endsWith('.' + expected);
}

function isSupportedDocumentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    if (!DOCUMENT_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(url.hostname, suffix))) return false;
    return DOCUMENT_PATH_RE.test(url.pathname + url.search + url.hash);
  } catch (error) {
    return false;
  }
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#([0-9]+);/g, function (_, decimal) {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(source) {
  const attrs = Object.create(null);
  const input = String(source || '');
  const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRe.exec(input)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] !== undefined ? match[2] : match[3]);
  }
  return attrs;
}

function parseDocumentXml(xml) {
  const source = String(xml || '');
  if (!source || utf8ByteLength(source) > MAX_XML_BYTES) {
    throw new Error('文档 XML 为空或超过安全上限');
  }

  const root = { name: '#root', attrs: Object.create(null), children: [], content: [], parent: null };
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\?[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[A-Za-z_:][^>]*>|[^<]+/g;
  let elementCount = 0;
  let match;

  while ((match = tokenRe.exec(source)) !== null) {
    const token = match[0];
    const current = stack[stack.length - 1];
    if (!token.startsWith('<')) {
      current.content.push(decodeXmlEntities(token));
      continue;
    }
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) {
      if (token.startsWith('<![CDATA[')) current.content.push(token.slice(9, -3));
      continue;
    }
    if (token.startsWith('</')) {
      const closeName = token.slice(2, -1).trim().toLowerCase();
      if (stack.length === 1 || stack[stack.length - 1].name !== closeName) {
        throw new Error('文档 XML 标签不匹配');
      }
      stack.pop();
      continue;
    }

    const selfClosing = /\/\s*>$/.test(token);
    const open = /^<([A-Za-z_:][A-Za-z0-9_.:-]*)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!open) throw new Error('文档 XML 标签格式无效');
    const node = {
      name: open[1].toLowerCase(),
      attrs: parseXmlAttributes(open[2]),
      children: [],
      content: [],
      parent: current,
    };
    current.children.push(node);
    current.content.push(node);
    elementCount += 1;
    if (elementCount > MAX_XML_ELEMENTS) throw new Error('文档 XML 元素数量超过安全上限');
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_XML_DEPTH) throw new Error('文档 XML 嵌套过深');
    }
  }
  if (stack.length !== 1) throw new Error('文档 XML 未完整闭合');
  return root;
}

function getElementText(node) {
  if (!node) return '';
  return (node.content || []).map(function (part) {
    return typeof part === 'string' ? part : getElementText(part);
  }).join('');
}

function walkElements(root, visitor) {
  (root && root.children || []).forEach(function visit(node) {
    visitor(node);
    (node.children || []).forEach(visit);
  });
}

function findDeepestExactTextNode(tree, exactText) {
  const candidates = [];
  walkElements(tree, function (node) {
    if (getElementText(node).trim() !== exactText) return;
    if (!BLOCK_ID_RE.test(String(node.attrs.id || ''))) return;
    candidates.push(node);
  });
  const leafCandidates = candidates.filter(function (candidate) {
    return !candidates.some(function (other) {
      let current = other && other.parent;
      while (current) {
        if (current === candidate) return true;
        current = current.parent;
      }
      return false;
    });
  });
  if (leafCandidates.length > 1) throw new Error('目标文档包含重复的迁移所有权标识');
  return leafCandidates[0] || null;
}

function findExactTextBlock(xmlOrTree, exactText) {
  const text = String(exactText || '');
  if (!text || utf8ByteLength(text) > 4096) throw new Error('迁移所有权标识无效');
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const node = findDeepestExactTextNode(tree, text);
  return node ? { blockId: String(node.attrs.id) } : null;
}

function followingWhiteboard(node) {
  const siblings = node && node.parent ? node.parent.children : [];
  const index = siblings.indexOf(node);
  const candidate = index >= 0 ? siblings[index + 1] : null;
  if (!candidate || candidate.name !== 'whiteboard') return null;
  const blockId = String(candidate.attrs.id || '');
  const token = String(candidate.attrs.token || '');
  if (!BLOCK_ID_RE.test(blockId) || !RESOURCE_TOKEN_RE.test(token)) {
    throw new Error('迁移所有权标识后的画板 block/token 无效');
  }
  return { blockId: blockId, token: token };
}

function findOwnershipRecord(xmlOrTree, ownershipMarker) {
  const marker = String(ownershipMarker || '');
  if (!OWNERSHIP_MARKER_RE.test(marker)) throw new Error('迁移所有权标识无效');
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const ownerNode = findDeepestExactTextNode(tree, marker);
  if (!ownerNode) return null;
  const board = followingWhiteboard(ownerNode);
  if (!board) throw new Error('迁移所有权标识与画板不再相邻');
  return {
    ownershipMarkerBlockId: String(ownerNode.attrs.id),
    boardBlockId: board.blockId,
    boardToken: board.token,
  };
}

function findOwnedWhiteboard(xmlOrTree, transferMarker, ownershipMarker) {
  const originalMarker = String(transferMarker || '');
  const ownerMarker = String(ownershipMarker || '');
  if (!MARKER_RE.test(originalMarker) || !OWNERSHIP_MARKER_RE.test(ownerMarker)) {
    throw new Error('迁移标识无效');
  }
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const transferNode = findDeepestExactTextNode(tree, originalMarker);
  const ownerNode = findDeepestExactTextNode(tree, ownerMarker);
  if (!ownerNode) return null;
  if (!transferNode || transferNode.parent !== ownerNode.parent) {
    throw new Error('迁移所有权标识已被移动');
  }
  const siblings = transferNode.parent.children;
  if (siblings[siblings.indexOf(transferNode) + 1] !== ownerNode) {
    throw new Error('迁移标识与所有权标识不再相邻');
  }
  const board = followingWhiteboard(ownerNode);
  if (!board) throw new Error('迁移所有权标识与画板不再相邻');
  return {
    ownershipMarkerBlockId: String(ownerNode.attrs.id),
    boardBlockId: board.blockId,
    boardToken: board.token,
  };
}

function listDocumentWhiteboards(xmlOrTree) {
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const boards = [];
  walkElements(tree, function (node) {
    if (node.name !== 'whiteboard') return;
    const blockId = String(node.attrs.id || '');
    const token = String(node.attrs.token || '');
    if (!BLOCK_ID_RE.test(blockId) || !RESOURCE_TOKEN_RE.test(token)) {
      throw new Error('文档包含无效的画板 block/token');
    }
    boards.push({ blockId: blockId, token: token });
  });
  if (boards.length > MAX_BOARDS) throw new Error('画板数量超过安全上限');
  return boards;
}

function summarizeDocumentStructure(xmlOrTree) {
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const summary = { blockCount: 0, equationCount: 0, imageCount: 0, whiteboardCount: 0 };
  function hasMeaningfulText(node) {
    return !!getElementText(node).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\s]/g, '');
  }
  function isContentfulTopBlock(node) {
    const name = String(node && node.name || '');
    if (name === 'title' || name === 'whiteboard' || name === 'ul' || name === 'ol') return false;
    if (name === 'img' || name === 'table' || name === 'pre' || name === 'hr'
      || name === 'diagram' || name === 'synced-reference') return true;
    return hasMeaningfulText(node);
  }
  // 与页面 renderer 的 blockCount 语义一致：只统计可独立粘贴的顶层正文块；
  // ul/ol 是容器，按其直接 li 计数，嵌套表格单元格与内部段落不重复计数。
  (tree.children || []).forEach(function (node) {
    if (node.name === 'ul' || node.name === 'ol') {
      summary.blockCount += (node.children || []).filter(function (child) {
        return child.name === 'li' && hasMeaningfulText(child);
      }).length;
    } else if (isContentfulTopBlock(node)) {
      summary.blockCount += 1;
    }
  });
  walkElements(tree, function (node) {
    const name = String(node && node.name || '');
    if (name === 'img') summary.imageCount += 1;
    if (name === 'whiteboard') summary.whiteboardCount += 1;
    if (name === 'equation' || name === 'equation-block' || name === 'math' || name === 'formula') {
      summary.equationCount += 1;
    }
  });
  if (summary.whiteboardCount > MAX_BOARDS) throw new Error('画板数量超过安全上限');
  if (summary.imageCount > MAX_ASSETS) throw new Error('正文图片数量超过安全上限');
  return summary;
}

function createBundleId() {
  return crypto.randomBytes(32).toString('hex');
}

function buildSlotId(index) {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value >= MAX_BOARDS) throw new Error('画板序号无效');
  return 'board-' + String(value + 1).padStart(4, '0');
}

function buildMarker(bundleId, slotId) {
  if (!BUNDLE_ID_RE.test(String(bundleId || '')) || !SLOT_ID_RE.test(String(slotId || ''))) {
    throw new Error('画板迁移标识无效');
  }
  return '[[FEISHU_HELPER_WHITEBOARD:' + bundleId + ':' + slotId + ']]';
}

function buildOwnershipMarker(bundleId, slotId, nonce) {
  if (!BUNDLE_ID_RE.test(String(bundleId || '')) || !SLOT_ID_RE.test(String(slotId || ''))
    || !OWNERSHIP_NONCE_RE.test(String(nonce || ''))) {
    throw new Error('画板迁移所有权标识无效');
  }
  return '[[FEISHU_HELPER_WHITEBOARD_OWNERSHIP:' + bundleId + ':' + slotId + ':' + nonce + ']]';
}

function createTransferMetadata(bundleId, sourceBoards) {
  if (!BUNDLE_ID_RE.test(String(bundleId || ''))) throw new Error('bundleId 无效');
  const boards = Array.isArray(sourceBoards) ? sourceBoards : [];
  if (!boards.length || boards.length > MAX_BOARDS) throw new Error('画板数量无效');
  const slots = boards.map(function (board, index) {
    const slotId = buildSlotId(index);
    const sourceBlockId = String(board && board.blockId || '');
    if (!BLOCK_ID_RE.test(sourceBlockId)) throw new Error('源画板 block ID 无效');
    return {
      slotId: slotId,
      sourceBlockId: sourceBlockId,
      marker: buildMarker(bundleId, slotId),
    };
  });
  return {
    schemaVersion: 1,
    bundleId: bundleId,
    boardCount: slots.length,
    slots: slots,
  };
}

function validateTransferMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1 || !BUNDLE_ID_RE.test(String(value.bundleId || ''))) return false;
  if (!Number.isInteger(value.boardCount) || value.boardCount < 1 || value.boardCount > MAX_BOARDS) return false;
  if (!Array.isArray(value.slots) || value.slots.length !== value.boardCount) return false;
  const seenSlots = new Set();
  const seenBlocks = new Set();
  for (const slot of value.slots) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
    if (!SLOT_ID_RE.test(String(slot.slotId || '')) || !BLOCK_ID_RE.test(String(slot.sourceBlockId || ''))) return false;
    if (slot.marker !== buildMarker(value.bundleId, slot.slotId)) return false;
    if (seenSlots.has(slot.slotId) || seenBlocks.has(slot.sourceBlockId)) return false;
    seenSlots.add(slot.slotId);
    seenBlocks.add(slot.sourceBlockId);
  }
  return true;
}

function findTransferMarkers(xmlOrTree, transfer) {
  if (!validateTransferMetadata(transfer)) throw new Error('画板迁移元数据无效');
  const tree = typeof xmlOrTree === 'string' ? parseDocumentXml(xmlOrTree) : xmlOrTree;
  const byMarker = new Map(transfer.slots.map((slot) => [slot.marker, slot]));
  const candidates = new Map();

  walkElements(tree, function (node) {
    const text = getElementText(node).trim();
    const slot = byMarker.get(text);
    if (!slot) return;
    if (!BLOCK_ID_RE.test(String(node.attrs.id || ''))) return;
    if (!candidates.has(slot.slotId)) candidates.set(slot.slotId, []);
    candidates.get(slot.slotId).push(node);
  });

  const matches = new Map();
  transfer.slots.forEach(function (slot) {
    const slotCandidates = candidates.get(slot.slotId) || [];
    // with-ids XML may put an ID on both a container and its nested text block.
    // Bind the marker to the deepest exact-text block so block_delete never
    // targets the enclosing callout/grid. Separate leaf blocks are duplicates.
    const leafCandidates = slotCandidates.filter(function (candidate) {
      return !slotCandidates.some(function (other) {
        let current = other && other.parent;
        while (current) {
          if (current === candidate) return true;
          current = current.parent;
        }
        return false;
      });
    });
    if (leafCandidates.length > 1) throw new Error('目标文档包含重复画板占位符');
    if (!leafCandidates.length) return;
    const node = leafCandidates[0];
    const siblings = node.parent ? node.parent.children : [];
    const index = siblings.indexOf(node);
    let followingBoard = null;
    if (index >= 0 && siblings[index + 1] && siblings[index + 1].name === 'whiteboard') {
      const candidate = siblings[index + 1];
      const blockId = String(candidate.attrs.id || '');
      const token = String(candidate.attrs.token || '');
      if (BLOCK_ID_RE.test(blockId) && RESOURCE_TOKEN_RE.test(token)) {
        followingBoard = { blockId: blockId, token: token };
      }
    }
    matches.set(slot.slotId, {
      slotId: slot.slotId,
      marker: slot.marker,
      markerBlockId: String(node.attrs.id),
      followingBoard: followingBoard,
    });
  });

  return transfer.slots.map((slot) => matches.get(slot.slotId)).filter(Boolean);
}

function assertJsonValue(value, state, depth) {
  if (depth > 64) throw new Error('画板节点嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('画板节点包含非有限数值');
    return;
  }
  if (Array.isArray(value)) {
    state.keys += value.length;
    if (state.keys > 1000000) throw new Error('画板节点字段数量超过安全上限');
    value.forEach((entry) => assertJsonValue(entry, state, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('画板节点包含不支持的值');
  }
  const keys = Object.keys(value);
  state.keys += keys.length;
  if (state.keys > 1000000) throw new Error('画板节点字段数量超过安全上限');
  keys.forEach(function (key) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error('画板节点包含危险字段名');
    }
    assertJsonValue(value[key], state, depth + 1);
  });
}

function validateRawNodes(nodes, stats) {
  if (!Array.isArray(nodes)) throw new Error('画板 raw 数据必须包含 nodes 数组');
  if (nodes.length > MAX_NODES) throw new Error('画板节点数量超过安全上限');
  const json = JSON.stringify(nodes);
  const byteLength = utf8ByteLength(json);
  if (byteLength > MAX_NODE_JSON_BYTES) throw new Error('画板节点 JSON 超过安全上限');
  if (stats && typeof stats === 'object') stats.byteLength = byteLength;
  assertJsonValue(nodes, { keys: 0 }, 0);
  return nodes;
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function decodeStrictXmlEntities(value) {
  const source = String(value || '');
  const validEntityRe = /&(?:#x[0-9A-Fa-f]+|#[0-9]+|quot|apos|lt|gt|amp);/g;
  if (source.replace(validEntityRe, '').includes('&')) {
    throw new Error('画板 SVG 包含未知或格式错误的 XML 实体');
  }
  return source.replace(validEntityRe, function (entity) {
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&amp;') return '&';
    const hexadecimal = entity.startsWith('&#x');
    const code = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff
      || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error('画板 SVG 包含无效的 XML 字符实体');
    }
    return String.fromCodePoint(code);
  });
}

function decodeCssEscapes(value) {
  return String(value || '').replace(/\\([0-9A-Fa-f]{1,6})(?:\s)?|\\([^\r\n])/g, function (_, hex, escaped) {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return escaped || '';
  });
}

function assertSvgCodeHasNoExternalResources(svgCode) {
  const rawSource = String(svgCode || '');
  if (!rawSource) return;
  const source = decodeStrictXmlEntities(rawSource);
  const cssCanonical = decodeCssEscapes(source.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (/<\s*(?:image|foreignObject|script)\b/i.test(source)
    || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)
    || /<\?\s*xml-stylesheet\b/i.test(source)) {
    throw new Error('画板 SVG 包含不受支持的外部资源元素');
  }

  const hrefRe = /\b(?:xlink:)?href\s*=\s*(["'])([\s\S]*?)\1/gi;
  let match;
  while ((match = hrefRe.exec(source)) !== null) {
    if (!/^\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*$/.test(match[2])) {
      throw new Error('画板 SVG 包含外部 href 引用');
    }
  }

  const cssUrlRe = /\burl\s*\(\s*(["']?)([\s\S]*?)\1\s*\)/gi;
  while ((match = cssUrlRe.exec(cssCanonical)) !== null) {
    if (!/^\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*$/.test(match[2])) {
      throw new Error('画板 SVG 包含外部 CSS URL 引用');
    }
  }

  const withoutNamespaces = source.replace(
    /\bxmlns(?::[A-Za-z_][A-Za-z0-9_.-]*)?\s*=\s*(["'])[\s\S]*?\1/gi,
    ''
  );
  const canonicalWithoutNamespaces = decodeCssEscapes(withoutNamespaces.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (/(?:https?:|data:|javascript:|file:|\\\\|\/\/)/i.test(canonicalWithoutNamespaces)
    || /@import\b/i.test(canonicalWithoutNamespaces)) {
    throw new Error('画板 SVG 包含外部资源地址');
  }
}

function sanitizeRawNodesForTransfer(nodes, stats) {
  const clone = deepCloneJson(validateRawNodes(nodes, stats));
  clone.forEach(function (node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.sticky_note && typeof node.sticky_note === 'object'
      && !Array.isArray(node.sticky_note)) {
      delete node.sticky_note.user_id;
    }
    if (node.svg && typeof node.svg === 'object' && !Array.isArray(node.svg)
      && typeof node.svg.svg_code === 'string') {
      assertSvgCodeHasNoExternalResources(node.svg.svg_code);
    }
  });
  return clone;
}

function collectImageTokenBindings(nodes, options) {
  if (!(options && options.validated)) validateRawNodes(nodes);
  const bindings = [];
  nodes.forEach(function (node, nodeIndex) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.type !== 'image') return;
    const image = node.image;
    if (!image || typeof image !== 'object' || Array.isArray(image)) return;
    const token = String(image.token || '');
    if (!token) return;
    if (!RESOURCE_TOKEN_RE.test(token)) throw new Error('画板图片 token 格式无效');
    bindings.push({ nodeIndex: nodeIndex, path: ['image', 'token'], sourceToken: token });
  });
  if (bindings.length > MAX_ASSETS) throw new Error('画板图片数量超过安全上限');
  return bindings;
}

function replaceSourceTokensWithAssets(nodes, bindings, sourceTokenToAssetId) {
  const clone = deepCloneJson(validateRawNodes(nodes));
  const normalizedBindings = [];
  (bindings || []).forEach(function (binding) {
    const assetId = sourceTokenToAssetId && sourceTokenToAssetId[binding.sourceToken];
    if (!/^[a-f0-9]{64}$/.test(String(assetId || ''))) throw new Error('画板图片未映射到本地资源');
    const node = clone[binding.nodeIndex];
    if (!node || !node.image || node.image.token !== binding.sourceToken) {
      throw new Error('画板图片 binding 与节点不一致');
    }
    node.image.token = 'feishu-helper-asset:' + assetId;
    normalizedBindings.push({
      nodeIndex: binding.nodeIndex,
      path: ['image', 'token'],
      assetId: assetId,
    });
  });
  return { nodes: clone, bindings: normalizedBindings };
}

function applyTargetAssetTokens(nodes, bindings, assetIdToTargetToken) {
  const clone = deepCloneJson(validateRawNodes(nodes));
  (bindings || []).forEach(function (binding) {
    if (!binding || !Number.isInteger(binding.nodeIndex) || binding.nodeIndex < 0 || binding.nodeIndex >= clone.length) {
      throw new Error('画板图片 binding 序号无效');
    }
    if (!Array.isArray(binding.path) || binding.path.length !== 2
      || binding.path[0] !== 'image' || binding.path[1] !== 'token') {
      throw new Error('画板图片 binding 路径无效');
    }
    const assetId = String(binding.assetId || '');
    const targetToken = String(assetIdToTargetToken && assetIdToTargetToken[assetId] || '');
    if (!/^[a-f0-9]{64}$/.test(assetId) || !RESOURCE_TOKEN_RE.test(targetToken)) {
      throw new Error('目标画板图片 token 缺失或无效');
    }
    const node = clone[binding.nodeIndex];
    if (!node || !node.image || node.image.token !== 'feishu-helper-asset:' + assetId) {
      throw new Error('画板图片占位符与 binding 不一致');
    }
    node.image.token = targetToken;
  });
  return clone;
}

function createIdempotentToken(bundleId, targetDocumentId, slotId, targetBoardToken) {
  if (!BUNDLE_ID_RE.test(String(bundleId || '')) || !SLOT_ID_RE.test(String(slotId || ''))
    || !BLOCK_ID_RE.test(String(targetDocumentId || ''))
    || (targetBoardToken != null && !RESOURCE_TOKEN_RE.test(String(targetBoardToken)))) {
    throw new Error('无法生成稳定幂等 token');
  }
  return 'fsh-' + crypto.createHash('sha256')
    .update(bundleId + '\0' + targetDocumentId + '\0' + slotId + '\0' + String(targetBoardToken || ''))
    .digest('hex')
    .slice(0, 40);
}

function assertBundleDoesNotContainSourceTokens(bundle, sourceTokens) {
  const serialized = JSON.stringify(bundle);
  (sourceTokens || []).forEach(function (token) {
    if (token && serialized.includes(String(token))) {
      throw new Error('迁移 bundle 泄露了源租户资源 token');
    }
  });
}

module.exports = Object.freeze({
  BLOCK_ID_RE,
  BUNDLE_ID_RE,
  BUNDLE_SCHEMA_VERSION,
  BUNDLE_TTL_MS,
  MARKER_RE,
  OWNERSHIP_MARKER_RE,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_BUNDLE_ASSET_BYTES,
  MAX_BUNDLE_NODE_JSON_BYTES,
  MAX_BOARDS,
  MAX_NODE_JSON_BYTES,
  MAX_NODES,
  RESOURCE_TOKEN_RE,
  SLOT_ID_RE,
  applyTargetAssetTokens,
  assertBundleDoesNotContainSourceTokens,
  assertSvgCodeHasNoExternalResources,
  buildMarker,
  buildOwnershipMarker,
  buildSlotId,
  collectImageTokenBindings,
  createBundleId,
  createIdempotentToken,
  createTransferMetadata,
  findExactTextBlock,
  findOwnedWhiteboard,
  findOwnershipRecord,
  findTransferMarkers,
  getElementText,
  isSupportedDocumentUrl,
  listDocumentWhiteboards,
  parseDocumentXml,
  parseXmlAttributes,
  replaceSourceTokensWithAssets,
  sanitizeRawNodesForTransfer,
  summarizeDocumentStructure,
  validateRawNodes,
  validateTransferMetadata,
});
