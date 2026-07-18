  // ── Structured image extraction panel ─────────────────────────────────────

  function extractImages() {
    var content = null;
    try { content = extractFullDoc(); } catch (error) {}
    return content ? buildImageEntriesFromDocxRecord(content.docxRecord) : [];
  }

  function ensureImagePanelStyles() {
    if (document.getElementById('__feishu_image_panel_styles__')) return;
    var style = document.createElement('style');
    style.id = '__feishu_image_panel_styles__';
    style.textContent = [
      '.feishu-imgx__mask{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,0.45);font-family:"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '-webkit-font-smoothing:antialiased;}',
      '.feishu-imgx__dialog{display:flex;flex-direction:column;background:#fff;border-radius:8px;',
      'box-shadow:0 6px 16px 0 rgba(0,0,0,0.08),0 3px 6px -4px rgba(0,0,0,0.12),0 9px 28px 8px rgba(0,0,0,0.05);',
      'max-width:min(880px,86vw);max-height:82vh;width:100%;overflow:hidden;}',
      '.feishu-imgx__head{display:flex;justify-content:space-between;align-items:center;gap:16px;',
      'padding:16px 24px;border-bottom:1px solid #f0f0f0;flex:0 0 auto;}',
      '.feishu-imgx__title{margin:0;font-size:16px;font-weight:600;color:rgba(0,0,0,0.88);line-height:1.5;}',
      '.feishu-imgx__actions{display:flex;gap:8px;flex:0 0 auto;}',
      '.feishu-imgx__btn{height:32px;padding:0 15px;border-radius:6px;font-size:14px;line-height:30px;',
      'cursor:pointer;border:1px solid transparent;transition:all .2s cubic-bezier(.645,.045,.355,1);white-space:nowrap;}',
      '.feishu-imgx__btn--primary{background:#1677ff;color:#fff;border-color:#1677ff;}',
      '.feishu-imgx__btn--primary:hover{background:#4096ff;border-color:#4096ff;}',
      '.feishu-imgx__btn--primary:active{background:#0958d9;border-color:#0958d9;}',
      '.feishu-imgx__btn--default{background:#fff;color:rgba(0,0,0,0.88);border-color:#d9d9d9;}',
      '.feishu-imgx__btn--default:hover{color:#4096ff;border-color:#4096ff;}',
      '.feishu-imgx__btn--default:active{color:#0958d9;border-color:#0958d9;}',
      '.feishu-imgx__body{padding:20px 24px;overflow:auto;flex:1 1 auto;}',
      '.feishu-imgx__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:12px;}',
      '.feishu-imgx__card{display:flex;flex-direction:column;align-items:center;border:1px solid #f0f0f0;',
      'border-radius:8px;padding:12px;background:#fff;transition:box-shadow .2s ease,border-color .2s ease;}',
      '.feishu-imgx__card:hover{border-color:transparent;box-shadow:0 1px 2px -2px rgba(0,0,0,0.16),',
      '0 3px 6px 0 rgba(0,0,0,0.12),0 5px 12px 4px rgba(0,0,0,0.09);}',
      '.feishu-imgx__thumb{width:100%;height:150px;object-fit:contain;border-radius:4px;background:#fafafa;}',
      '.feishu-imgx__meta{margin-top:8px;font-size:12px;color:rgba(0,0,0,0.45);font-variant-numeric:tabular-nums;}',
      '.feishu-imgx__link{margin-top:4px;font-size:13px;color:#1677ff;text-decoration:none;transition:color .2s ease;}',
      '.feishu-imgx__link:hover{color:#4096ff;}',
    ].join('');
    document.head.appendChild(style);
  }

  function createImagePanel(images) {
    var existing = document.getElementById('__feishu_image_panel__');
    if (existing) existing.remove();
    ensureImagePanelStyles();

    var panel = document.createElement('div');
    panel.id = '__feishu_image_panel__';
    panel.className = 'feishu-imgx__mask';
    panel.innerHTML =
      '<div class="feishu-imgx__dialog" role="dialog" aria-modal="true" aria-label="图片提取">'
      + '<div class="feishu-imgx__head">'
      + '<h3 class="feishu-imgx__title"></h3>'
      + '<div class="feishu-imgx__actions">'
      + '<button id="__feishu_download_all__" class="feishu-imgx__btn feishu-imgx__btn--primary" type="button">全部下载</button>'
      + '<button id="__feishu_close_panel__" class="feishu-imgx__btn feishu-imgx__btn--default" type="button">关闭</button>'
      + '</div>'
      + '</div>'
      + '<div class="feishu-imgx__body">'
      + '<div class="feishu-imgx__grid"></div>'
      + '</div></div></div>';

    panel.querySelector('.feishu-imgx__title').textContent = '图片提取 (' + images.length + ' 张)';
    var grid = panel.querySelector('.feishu-imgx__grid');
    images.forEach(function (img, index) {
      var card = document.createElement('div');
      card.className = 'feishu-imgx__card';
      var preview = document.createElement('img');
      preview.className = 'feishu-imgx__thumb';
      preview.src = img.src;
      preview.crossOrigin = 'anonymous';
      preview.alt = '图片 ' + (index + 1);
      var metadata = document.createElement('div');
      metadata.className = 'feishu-imgx__meta';
      metadata.textContent = String(img.width || 0) + ' x ' + String(img.height || 0);
      var download = document.createElement('a');
      download.className = 'feishu-imgx__link';
      download.href = img.src;
      download.target = '_blank';
      download.rel = 'noopener noreferrer';
      download.download = 'feishu_img_' + (index + 1) + '.png';
      download.textContent = '下载';
      card.append(preview, metadata, download);
      grid.appendChild(card);
    });

    document.body.appendChild(panel);

    function closePanel() {
      panel.remove();
      document.removeEventListener('keydown', onKeydown, true);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') closePanel();
    }

    panel.querySelector('#__feishu_close_panel__').onclick = closePanel;
    panel.querySelector('#__feishu_download_all__').onclick = function () {
      images.forEach(function (img, i) {
        setTimeout(function () {
          var a = document.createElement('a');
          a.href = img.src;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.download = 'feishu_img_' + (i + 1) + '.png';
          a.click();
        }, i * 300);
      });
    };
    panel.addEventListener('click', function (e) {
      if (e.target === panel) closePanel();
    });
    document.addEventListener('keydown', onKeydown, true);
  }
