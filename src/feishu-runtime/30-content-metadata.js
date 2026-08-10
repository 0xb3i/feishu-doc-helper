  // ── Structured content metadata ────────────────────────────────────────────

  function listImageRecordsFromDocxRecord(raw) {
    if (!raw) return [];
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return docxRecord.listImageRecords(parsed).filter(function (entry) {
        return entry && entry.image && entry.image.token;
      });
    } catch (error) {
      return [];
    }
  }
  function buildImageEntriesFromDocxRecord(raw) {
    return listImageRecordsFromDocxRecord(raw).map(function (entry) {
      var image = entry.image || {};
      var token = String(image.token || '');
      return {
        src: location.origin + '/space/api/box/stream/download/preview/' + encodeURIComponent(token) + '/?preview_type=16',
        alt: String(image.name || ''),
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        token: token,
      };
    });
  }
  function countExtractedImages(content) {
    var c = content || {};
    var recordCount = listImageRecordsFromDocxRecord(c.docxRecord).length;
    if (recordCount > 0) return recordCount;
    if (Number(c.imageCount || 0) > 0) return Number(c.imageCount || 0);
    return 0;
  }

  function normalizePasteTitle(title) {
    return String(title || '').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function contentStartsWithTitle(content, title) {
    var firstLine = String((content && content.text) || '').split('\n').map(function (line) {
      return line.replace(/^#+\s*/, '').trim();
    }).filter(Boolean)[0] || '';
    return normalizePasteTitle(firstLine) === normalizePasteTitle(title);
  }

  function stripFirstHtmlTitle(html, title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!html || !cleanTitle) return html || '';
    var firstHeadingRe = /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i;
    var match = String(html || '').match(firstHeadingRe);
    if (!match) return html;
    var headingText = normalizePasteTitle(match[1].replace(/<[^>]+>/g, ''));
    return headingText === cleanTitle ? String(html || '').replace(firstHeadingRe, '') : html;
  }

  function stripFirstTextTitle(text, title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!text || !cleanTitle) return text || '';
    var lines = String(text || '').split('\n');
    var firstContentIndex = -1;
    for (var i = 0; i < lines.length; i++) {
      if (normalizePasteTitle(lines[i].replace(/^#+\s*/, ''))) {
        firstContentIndex = i;
        break;
      }
    }
    if (firstContentIndex < 0) return text;
    var firstLine = normalizePasteTitle(lines[firstContentIndex].replace(/^#+\s*/, ''));
    if (firstLine !== cleanTitle) return text;
    lines.splice(firstContentIndex, 1);
    while (lines.length && !normalizePasteTitle(lines[0])) lines.shift();
    return lines.join('\n');
  }

  function stripFirstTitleFromDocxRecord(raw, title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!raw || !cleanTitle) return raw || '';
    try {
      var record = JSON.parse(raw);
      if (!record || !record.recordMap || !Array.isArray(record.recordIds) || !record.recordIds.length) return raw;
      var firstRecordId = record.recordIds[0];
      var firstRecord = record.recordMap[firstRecordId] || {};
      var snap = firstRecord.snapshot || {};
      var firstText = normalizePasteTitle(attribs.decodeBlockText(snap));
      if (firstText !== cleanTitle) return raw;
      record.recordIds = record.recordIds.slice(1);
      delete record.recordMap[firstRecordId];
      if (record.payloadMap) delete record.payloadMap[firstRecordId];
      // docx/record 的块选择编号从 2 开始；必须与 selection.id 保持一致。
      // 从 1 重编号会让飞书把编号 1 解释成标题后残留的空正文块。
      record.blockIds = record.recordIds.map(function (_recordId, index) { return index + 2; });
      record.selection = record.recordIds.map(function (recordId, index) {
        return { id: index + 2, type: 'block', recordId: recordId };
      });
      return JSON.stringify(record);
    } catch (error) {
      return raw;
    }
  }

  function stripTitleFromContent(content, title) {
    var cleanTitle = normalizePasteTitle(title);
    if (!content || !cleanTitle || !contentStartsWithTitle(content, cleanTitle)) return content;
    var next = Object.assign({}, content);
    next.html = stripFirstHtmlTitle(next.html, cleanTitle);
    if (next.clipboardHtml) next.clipboardHtml = stripFirstHtmlTitle(next.clipboardHtml, cleanTitle);
    next.text = stripFirstTextTitle(next.text, cleanTitle);
    next.blockCount = Math.max(0, Number(next.blockCount || 0) - 1);
    next.docxRecord = stripFirstTitleFromDocxRecord(next.docxRecord, cleanTitle);
    return next;
  }
