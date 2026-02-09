import type { LaymaDocument, LaymaElement, LaymaTableElement } from '../model/model';

function escapeHtmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function elementInlineStyleMm(el: LaymaElement, zIndex: number): string {
  const stylePairs: Array<[string, string]> = [
    ['position', 'absolute'],
    ['left', `${el.xMm}mm`],
    ['top', `${el.yMm}mm`],
    ['width', `${el.widthMm}mm`],
    ['height', `${el.heightMm}mm`],
    ['z-index', String(zIndex)],
    ['box-sizing', 'border-box'],
  ];

  if (el.type === 'text') {
    stylePairs.push(['white-space', 'pre-wrap']);
    stylePairs.push(['font-family', el.fontFamily]);
    stylePairs.push(['font-size', `${el.fontSizePt}pt`]);
    stylePairs.push(['color', el.color]);
    stylePairs.push(['text-align', el.align]);
    stylePairs.push(['padding', `${el.paddingMm}mm`]);
  }

  if (el.type === 'rect') {
    stylePairs.push(['background', el.fillColor]);
    stylePairs.push(['border-style', 'solid']);
    stylePairs.push(['border-color', el.borderColor]);
    stylePairs.push(['border-width', `${el.borderWidthMm}mm`]);
    stylePairs.push(['border-radius', `${el.borderRadiusMm}mm`]);
  }

  if (el.type === 'line') {
    stylePairs.push(['background', el.color]);
  }

  if (el.type === 'image') {
    stylePairs.push(['overflow', 'hidden']);
    if (el.opacity < 1) stylePairs.push(['opacity', String(el.opacity)]);
    if (el.borderRadiusMm > 0) stylePairs.push(['border-radius', `${el.borderRadiusMm}mm`]);
  }

  if (el.type === 'table') {
    stylePairs.push(['overflow', 'hidden']);
  }

  return stylePairs.map(([k, v]) => `${k}:${v}`).join(';');
}

function tableHtml(el: LaymaTableElement, zIndex: number): string {
  const style = escapeHtmlAttr(elementInlineStyleMm(el, zIndex));
  // Repeat marker: external pipeline should duplicate the template row per dataset item.
  const repeatOpen = el.tableDataset
    ? `<layma-repeat dataset="${escapeHtmlAttr(el.tableDataset)}">`
    : '';
  const repeatClose = el.tableDataset ? `</layma-repeat>` : '';

  const colgroup = el.columns
    .map((c) => `<col style="width:${escapeHtmlAttr(`${c.widthMm}mm`)}" />`)
    .join('');

  const headerCells = el.header
    .map((c) => `<th class="layma-tableCell">${escapeHtmlText(c.text)}</th>`)
    .join('');

  const rowCells = el.rowTemplate
    .map((c) => `<td class="layma-tableCell">${escapeHtmlText(c.text)}</td>`)
    .join('');

  return [
    `<div class="layma-table" style="${style}">`,
    `<table class="layma-tableInner" cellspacing="0" cellpadding="0">`,
    `<colgroup>${colgroup}</colgroup>`,
    `<thead><tr>${headerCells}</tr></thead>`,
    `<tbody>`,
    `${repeatOpen}<tr class="layma-tableTemplate">${rowCells}</tr>${repeatClose}`,
    `</tbody>`,
    `</table>`,
    `</div>`,
  ].join('');
}

function elementHtml(el: LaymaElement, zIndex: number): string {
  const style = escapeHtmlAttr(elementInlineStyleMm(el, zIndex));

  if (el.type === 'text') {
    return `<div class="layma-text" style="${style}">${escapeHtmlText(el.text)}</div>`;
  }

  if (el.type === 'rect') {
    return `<div class="layma-rect" style="${style}"></div>`;
  }

  if (el.type === 'line') {
    return `<div class="layma-line" style="${style}"></div>`;
  }

  if (el.type === 'table') {
    return tableHtml(el, zIndex);
  }

  // image
  const src = escapeHtmlAttr(el.dataUri);
  const fit = escapeHtmlAttr(el.objectFit);
  return `<img class="layma-image" alt="" src="${src}" style="${style};object-fit:${fit};display:block" />`;
}

export function exportDocumentToHtml(doc: LaymaDocument): string {
  // Repeat contract: any <layma-repeat dataset="X"> wrapper marks a template row
  // that the external pipeline should duplicate for each item in dataset X.
  const { widthMm, heightMm } = doc.page;
  const elementsHtml = doc.elements.map((el, idx) => elementHtml(el, idx)).join('\n');

  const css = `
html,body{margin:0;padding:0}
.page{position:relative;width:${widthMm}mm;height:${heightMm}mm;background:#fff;overflow:hidden}
.layma-tableInner{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}
.layma-tableCell{border:0.3mm solid #cbd5e1;padding:1mm;font-family:Arial,Helvetica,sans-serif;font-size:9pt;vertical-align:top}
.layma-table thead .layma-tableCell{background:#f3f4f6;font-weight:700}
`.trim();

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    `<div class="page">`,
    elementsHtml,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
