import type { LaymaDocument, LaymaElement, LaymaTableCell, LaymaTableElement } from '../model/model';

const PT_PER_MM = 72 / 25.4; // iText tends to be more consistent in pt than mm for borders.

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

function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

function formatPt(pt: number): string {
  if (!Number.isFinite(pt) || pt <= 0) return '0';
  // Avoid long floats in HTML; keep enough precision for thin borders.
  const rounded = Math.round(pt * 100) / 100;
  // Trim trailing zeros (e.g. "3.00" -> "3", "2.80" -> "2.8").
  return String(rounded).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function borderShorthandFromMm(widthMm: number, color: string): string {
  if (!Number.isFinite(widthMm) || widthMm <= 0) return 'none';
  const widthPt = mmToPt(widthMm);
  return `${formatPt(widthPt)}pt solid ${color}`;
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
    stylePairs.push(['font-weight', el.fontWeight]);
    stylePairs.push(['font-size', `${el.fontSizePt}pt`]);
    stylePairs.push(['color', el.color]);
    stylePairs.push(['text-align', el.align]);
    stylePairs.push(['padding', `${el.paddingMm}mm`]);
  }

  if (el.type === 'rect') {
    stylePairs.push(['background', el.fillColor]);
    stylePairs.push(['border', borderShorthandFromMm(el.borderWidthMm, el.borderColor)]);
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

function tableCells(el: LaymaTableElement, kind: 'header' | 'rowTemplate' | 'footer'): readonly LaymaTableCell[] {
  const count = Math.max(1, el.columns.length);
  const current =
    kind === 'header' ? el.header : kind === 'footer' ? (el.footer ?? []) : el.rowTemplate;

  return Array.from({ length: count }, (_, i) => {
    const existing = current[i];
    if (existing) return existing;
    const isHeader = kind === 'header';
    const text =
      kind === 'header'
        ? `Header${i + 1}`
        : kind === 'rowTemplate' || kind === 'footer'
          ? `#InvoiceLine_Field${i + 1}#`
          : '';
    return { text, isHeader };
  });
}

function tableCellStyleAttr(
  el: LaymaTableElement,
  cell: LaymaTableCell,
  kind: 'header' | 'rowTemplate' | 'footer',
  colIndex: number
): string {
  const borderColor = cell.style?.borderColor ?? el.borderColor;
  const borderWidthMm = cell.style?.borderWidthMm ?? el.borderWidthMm;
  const fontWeight = cell.style?.fontWeight ?? (kind === 'header' ? 'bold' : 'normal');
  const textAlign = cell.style?.align ?? el.columns[colIndex]?.align ?? 'left';

  const stylePairs: Array<[string, string]> = [
    // iText html2pdf is picky with border-collapse + separate border props.
    // Use `border:` shorthand and pt for consistent PDF rendering.
    ['border', borderShorthandFromMm(borderWidthMm, borderColor)],
    ['font-weight', fontWeight],
    ['text-align', textAlign],
  ];

  if (kind === 'header') stylePairs.push(['background', el.headerBackground]);
  if (kind === 'footer') stylePairs.push(['background', el.footerBackground]);
  return escapeHtmlAttr(stylePairs.map(([k, v]) => `${k}:${v}`).join(';'));
}

function tableHtml(el: LaymaTableElement, zIndex: number): string {
  const style = escapeHtmlAttr(elementInlineStyleMm(el, zIndex));
  const DEFAULT_TABLE_ROW_HEIGHT_MM = 5;
  // Repeat marker: external pipeline should duplicate the template row per dataset item.
  const repeatAttr = el.tableRepeatableType ?? el.tableDataset;
  const repeatAttrHtml = repeatAttr ? ` data-layma-repeat="${escapeHtmlAttr(repeatAttr)}"` : '';

  const mainTypeHtml = escapeHtmlAttr(el.tableMainType ?? '');
  const repeatableTypeHtml = escapeHtmlAttr(el.tableRepeatableType ?? '');

  const colgroup = el.columns
    .map((c) => `<col style="width:${escapeHtmlAttr(`${c.widthMm}mm`)}" />`)
    .join('');

  const headerCells = tableCells(el, 'header')
    .map(
      (c, i) =>
        `<th class="layma-tableCell" data-layma-cell="header" data-layma-col="${i}" style="${tableCellStyleAttr(
          el,
          c,
          'header',
          i
        )}">${escapeHtmlText(c.text)}</th>`
    )
    .join('');

  const rowCells = tableCells(el, 'rowTemplate')
    .map(
      (c, i) =>
        `<td class="layma-tableCell" data-layma-cell="body" data-layma-col="${i}" style="${tableCellStyleAttr(
          el,
          c,
          'rowTemplate',
          i
        )}">${escapeHtmlText(c.text)}</td>`
    )
    .join('');

  const footer = el.footer ?? null;
  const footerCells =
    footer && footer.length
      ? tableCells(el, 'footer')
          .map(
            (c, i) =>
              `<td class="layma-tableCell" data-layma-cell="footer" data-layma-col="${i}" style="${tableCellStyleAttr(
                el,
                c,
                'footer',
                i
              )}">${escapeHtmlText(c.text)}</td>`
          )
          .join('')
      : '';

  return [
    `<div class="layma-table" style="${style}" data-table-height="${escapeHtmlAttr(String(el.heightMm))}" data-table-row-height="${escapeHtmlAttr(String(DEFAULT_TABLE_ROW_HEIGHT_MM))}" data-table-main-type="${mainTypeHtml}" data-table-repeatable-type="${repeatableTypeHtml}">`,
    `<table class="layma-tableInner" cellspacing="0" cellpadding="0">`,
    `<colgroup>${colgroup}</colgroup>`,
    `<thead><tr>${headerCells}</tr></thead>`,
    `<tbody>`,
    `<tr class="layma-tableTemplate"${repeatAttrHtml}>${rowCells}</tr>`,
    `</tbody>`,
    footerCells ? `<tfoot><tr>${footerCells}</tr></tfoot>` : '',
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
  // Repeat contract: any row with data-layma-repeat="X" is a template row
  // that the external pipeline should duplicate for each item in dataset X.
  const { widthMm, heightMm } = doc.page;
  const elementsHtml = doc.elements.map((el, idx) => elementHtml(el, idx)).join('\n');

  const css = `
html,body{margin:0;padding:0}
.page{position:relative;width:${widthMm}mm;height:${heightMm}mm;background:#fff;overflow:hidden}
.layma-tableInner{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}
.layma-tableCell{border:${borderShorthandFromMm(0.3, '#cbd5e1')};padding:1mm;font-family:Arial,Helvetica,sans-serif;font-size:9pt;vertical-align:top}
.layma-table thead .layma-tableCell{font-weight:700}
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
