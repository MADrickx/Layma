import {
  type LaymaDocument,
  type LaymaElement,
  type LaymaImageElement,
  type LaymaLineElement,
  type LaymaSection,
  type LaymaTableCell,
  type LaymaTableColumn,
  type LaymaTableElement,
  type LaymaTextElement,
  createLaymaElementId,
} from '../../model/model';

const TRANSPARENT_PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/wcAAwAB/8p8qQAAAABJRU5ErkJggg==';

function svgPlaceholderDataUri(label: string): string {
  const safe = label.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">
  <rect x="0" y="0" width="100%" height="100%" fill="#f3f4f6" stroke="#cbd5e1"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#111827" font-family="Arial" font-size="14">
    ${safe}
  </text>
</svg>`.trim();
  const encoded = encodeURIComponent(svg)
    .replaceAll('%0A', '')
    .replaceAll('%20', ' ')
    .replaceAll('%3D', '=')
    .replaceAll('%3A', ':')
    .replaceAll('%2F', '/');
  return `data:image/svg+xml,${encoded}`;
}

function mmFromRdlSize(value: string): number {
  const trimmed = value.trim();
  const match = /^(-?\d+(?:\.\d+)?)(cm|mm|in|pt)$/i.exec(trimmed);
  if (!match) return Number.NaN;
  const num = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(num)) return Number.NaN;
  if (unit === 'mm') return num;
  if (unit === 'cm') return num * 10;
  if (unit === 'in') return num * 25.4;
  // pt
  return (num * 25.4) / 72;
}

function firstTextContentByTagNS(root: ParentNode, localName: string): string | null {
  const el = (root as Document | Element).getElementsByTagNameNS('*', localName).item(0);
  return el?.textContent?.trim() ?? null;
}

function reportItemsElement(
  sectionEl: Element,
  sectionName: 'PageHeader' | 'Body' | 'PageFooter'
): Element | null {
  const section = sectionEl.getElementsByTagNameNS('*', sectionName).item(0);
  if (!section) return null;
  return section.getElementsByTagNameNS('*', 'ReportItems').item(0);
}

function parsePositionBoxMm(
  itemEl: Element
): { xMm: number; yMm: number; widthMm: number; heightMm: number } | null {
  const left = firstTextContentByTagNS(itemEl, 'Left');
  const top = firstTextContentByTagNS(itemEl, 'Top');
  const width = firstTextContentByTagNS(itemEl, 'Width');
  const height = firstTextContentByTagNS(itemEl, 'Height');
  if (!left || !top || !width || !height) return null;
  const xMm = mmFromRdlSize(left);
  const yMm = mmFromRdlSize(top);
  const widthMm = mmFromRdlSize(width);
  const heightMm = mmFromRdlSize(height);
  if (![xMm, yMm, widthMm, heightMm].every((n) => Number.isFinite(n))) return null;
  return { xMm, yMm, widthMm, heightMm };
}

function parseColor(value: string | null): string {
  if (!value) return '#111';
  const v = value.trim();
  if (v.startsWith('#')) return v;
  // RDL can have color names like "Gray" or "Silver" - keep as-is (CSS supports many).
  return v;
}

function parseTextAlign(value: string | null): 'left' | 'center' | 'right' {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'center') return 'center';
  if (v === 'right') return 'right';
  return 'left';
}

/**
 * Build a placeholder tag: `#Category_Field#`.
 * Example: `#InvoiceHeader_DocumentNumber#`
 */
function toCtTag(category: string, field: string): string {
  return `#${category}_${field}#`;
}

/**
 * Parse an RDL expression into placeholder tags that match `#*CT*Category_Field#`.
 *
 * Strategy: extract every Fields!X.Value and Parameters!X.Value reference,
 * resolve the dataset name from the optional First(..., "Dataset") wrapper,
 * and produce `#Dataset_Field#` tokens. String concatenations (`&` / `+`)
 * become spaces between tokens. Anything we can't simplify stays as a
 * readable fallback.
 */
function textFromRdlValue(rdlValue: string, datasetHint: string): string {
  const v = rdlValue.trim();
  if (!v.startsWith('=')) return v;

  const expr = v.slice(1).trim();

  // Collect all field and parameter references in order of appearance.
  const tokens: string[] = [];
  const refPattern =
    /(?:First\s*\(\s*)?Fields!([A-Za-z0-9_]+)\.Value(?:\s*,\s*"([^"]+)")?\s*\)?|Parameters!([A-Za-z0-9_]+)\.Value|Globals!([A-Za-z0-9_]+)/gi;

  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(expr)) !== null) {
    const fieldName = match[1];
    const explicitDataset = match[2];
    const paramName = match[3];
    const globalName = match[4];

    if (fieldName) {
      const ds = explicitDataset ?? datasetHint;
      tokens.push(toCtTag(ds, fieldName));
    } else if (paramName) {
      tokens.push(paramName);
    } else if (globalName) {
      tokens.push(toCtTag('Globals', globalName));
    }
  }

  if (tokens.length > 0) return tokens.join(' ');

  // Fallback: static strings like ="Powered by IGFact Web"
  const staticMatch = /^"([^"]*)"$/.exec(expr);
  if (staticMatch) return staticMatch[1];

  // Last resort: return the raw expression trimmed
  return expr;
}

function buildEmbeddedImagesMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  const embeddedImages = doc.getElementsByTagNameNS('*', 'EmbeddedImage');
  for (const imgEl of Array.from(embeddedImages)) {
    const name = imgEl.getAttribute('Name');
    if (!name) continue;
    const mime = firstTextContentByTagNS(imgEl, 'MIMEType') ?? 'image/png';
    const data = firstTextContentByTagNS(imgEl, 'ImageData');
    if (!data) continue;
    map.set(name, `data:${mime};base64,${data}`);
  }
  return map;
}

function resolveEmbeddedImageDataUri(
  valueExpression: string,
  embedded: Map<string, string>
): string | null {
  const v = valueExpression.trim();
  if (!v.startsWith('=')) {
    return embedded.get(v) ?? null;
  }

  const paramMatch = /=\s*Parameters!([A-Za-z0-9_]+)\.Value/i.exec(v);
  if (paramMatch) {
    const paramName = paramMatch[1];
    // Heuristic for your file: phone241 -> phone24, clavier501 -> clavier50
    if (embedded.has(paramName)) return embedded.get(paramName) ?? null;
    if (paramName.endsWith('1')) {
      const trimmed = paramName.slice(0, -1);
      if (embedded.has(trimmed)) return embedded.get(trimmed) ?? null;
    }
    return null;
  }

  return null;
}

function importTextbox(
  textboxEl: Element,
  offsetMm: { xMm: number; yMm: number },
  datasetHint: string,
  section: LaymaSection
): LaymaTextElement | null {
  const box = parsePositionBoxMm(textboxEl);
  if (!box) return null;

  // Pull first TextRun value.
  const valueEl = textboxEl.getElementsByTagNameNS('*', 'Value').item(0);
  const value = valueEl?.textContent?.trim() ?? '';
  const text = textFromRdlValue(value, datasetHint);

  const fontFamily =
    firstTextContentByTagNS(textboxEl, 'FontFamily') ?? 'Arial, Helvetica, sans-serif';
  const fontSize = firstTextContentByTagNS(textboxEl, 'FontSize');
  const fontSizePt = fontSize ? mmFromRdlSize(fontSize) * (72 / 25.4) : 12;
  const color = parseColor(firstTextContentByTagNS(textboxEl, 'Color'));
  const align = parseTextAlign(firstTextContentByTagNS(textboxEl, 'TextAlign'));

  // RDL uses individual PaddingLeft/PaddingRight/PaddingTop/PaddingBottom; pick the largest as uniform.
  const paddings = ['PaddingLeft', 'PaddingRight', 'PaddingTop', 'PaddingBottom']
    .map((tag) => mmFromRdlSize(firstTextContentByTagNS(textboxEl, tag) ?? '0mm'))
    .filter((v) => Number.isFinite(v));
  const paddingMm = paddings.length > 0 ? Math.max(...paddings) : 1;

  return {
    id: createLaymaElementId(),
    type: 'text',
    section,
    xMm: offsetMm.xMm + box.xMm,
    yMm: offsetMm.yMm + box.yMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    text,
    fontFamily,
    fontSizePt: Number.isFinite(fontSizePt) ? Math.max(1, Math.round(fontSizePt * 10) / 10) : 12,
    color,
    align,
    paddingMm,
  };
}

function importLine(
  lineEl: Element,
  offsetMm: { xMm: number; yMm: number },
  section: LaymaSection
): LaymaLineElement | null {
  const box = parsePositionBoxMm(lineEl);
  if (!box) return null;
  const borderColor = parseColor(firstTextContentByTagNS(lineEl, 'Color'));
  const thicknessMm = Math.max(0.3, box.heightMm === 0 ? 0.3 : box.heightMm);

  return {
    id: createLaymaElementId(),
    type: 'line',
    section,
    xMm: offsetMm.xMm + box.xMm,
    yMm: offsetMm.yMm + box.yMm,
    widthMm: box.widthMm,
    heightMm: thicknessMm,
    color: borderColor,
  };
}

function importImage(
  imgEl: Element,
  offsetMm: { xMm: number; yMm: number },
  embedded: Map<string, string>,
  datasetHint: string,
  section: LaymaSection
): LaymaImageElement | null {
  const box = parsePositionBoxMm(imgEl);
  if (!box) return null;

  const sizing = (firstTextContentByTagNS(imgEl, 'Sizing') ?? '').trim();
  const objectFit: LaymaImageElement['objectFit'] =
    sizing === 'FitProportional' ? 'contain' : sizing === 'Fit' ? 'fill' : 'contain';

  const source = (firstTextContentByTagNS(imgEl, 'Source') ?? '').trim();
  const rawValue = firstTextContentByTagNS(imgEl, 'Value') ?? '';

  let dataUri: string | null = null;
  if (source === 'Embedded') {
    dataUri = resolveEmbeddedImageDataUri(rawValue, embedded);
  }

  if (dataUri === null && source === 'External') {
    const hint = textFromRdlValue(rawValue, datasetHint);
    dataUri = svgPlaceholderDataUri(`External image ${hint}`);
  }

  if (dataUri === null) dataUri = TRANSPARENT_PNG_1PX;

  return {
    id: createLaymaElementId(),
    type: 'image',
    section,
    xMm: offsetMm.xMm + box.xMm,
    yMm: offsetMm.yMm + box.yMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    dataUri,
    objectFit,
    opacity: 1,
    borderRadiusMm: 0,
    aspectRatioLocked: true,
  };
}

function importTablixAsTable(
  tablixEl: Element,
  offsetMm: { xMm: number; yMm: number },
  datasetHint: string,
  section: LaymaSection
): LaymaTableElement | null {
  const box = parsePositionBoxMm(tablixEl);
  if (!box) return null;

  const columns: LaymaTableColumn[] = [];
  const colEls = tablixEl.getElementsByTagNameNS('*', 'TablixColumn');
  for (const colEl of Array.from(colEls)) {
    const w = firstTextContentByTagNS(colEl, 'Width');
    if (!w) continue;
    const widthMm = mmFromRdlSize(w);
    if (!Number.isFinite(widthMm)) continue;
    columns.push({ widthMm, align: 'left' });
  }

  // Extract first two tablix rows: header + one detail template row
  const rowEls = Array.from(tablixEl.getElementsByTagNameNS('*', 'TablixRow'));
  const headerRow = rowEls.at(0) ?? null;
  const detailRow = rowEls.at(1) ?? null;
  if (!headerRow || !detailRow) return null;

  const header = extractRowCells(headerRow, datasetHint, true);
  const rowTemplate = extractRowCells(detailRow, datasetHint, false);

  // If we couldn't extract, still create a usable table with empty cells
  const headerCells = header.length ? header : columns.map(() => ({ text: '', isHeader: true }));
  const rowCells = rowTemplate.length
    ? rowTemplate
    : columns.map(() => ({ text: '', isHeader: false }));

  // Normalize columns count to the extracted cells length (some RDLs differ)
  const cellCount = Math.max(headerCells.length, rowCells.length);
  const normalizedColumns = normalizeColumns(columns, box.widthMm, cellCount);

  return {
    id: createLaymaElementId(),
    type: 'table',
    section,
    xMm: offsetMm.xMm + box.xMm,
    yMm: offsetMm.yMm + box.yMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    columns: normalizedColumns,
    header: headerCells,
    rowTemplate: rowCells,
    borderColor: '#cbd5e1',
    borderWidthMm: 0.3,
    headerBackground: '#f3f4f6',
  };
}

function normalizeColumns(
  columns: readonly LaymaTableColumn[],
  tableWidthMm: number,
  cellCount: number
): LaymaTableColumn[] {
  if (columns.length === cellCount && columns.length > 0) return [...columns];
  if (columns.length > 0) {
    // Pad/trim to match count
    const base = [...columns];
    while (base.length < cellCount) base.push({ widthMm: tableWidthMm / cellCount, align: 'left' });
    return base.slice(0, cellCount);
  }
  const width = cellCount > 0 ? tableWidthMm / cellCount : tableWidthMm;
  return Array.from({ length: cellCount }, () => ({ widthMm: width, align: 'left' }));
}

function extractRowCells(
  tablixRowEl: Element,
  datasetHint: string,
  isHeader: boolean
): LaymaTableCell[] {
  const cells: LaymaTableCell[] = [];
  const cellEls = Array.from(tablixRowEl.getElementsByTagNameNS('*', 'TablixCell'));
  for (const cellEl of cellEls) {
    const textbox = cellEl.getElementsByTagNameNS('*', 'Textbox').item(0);
    if (!textbox) {
      cells.push({ text: '', isHeader });
      continue;
    }
    const valueEl = textbox.getElementsByTagNameNS('*', 'Value').item(0);
    const raw = valueEl?.textContent?.trim() ?? '';
    cells.push({ text: textFromRdlValue(raw, datasetHint), isHeader });
  }
  return cells;
}

export function importRdlToLaymaDocument(xmlText: string): LaymaDocument {
  const parsed = new DOMParser().parseFromString(xmlText, 'text/xml');

  const pageWidth = firstTextContentByTagNS(parsed, 'PageWidth') ?? '21cm';
  const pageHeight = firstTextContentByTagNS(parsed, 'PageHeight') ?? '29.7cm';
  const pageWidthMm = mmFromRdlSize(pageWidth);
  const pageHeightMm = mmFromRdlSize(pageHeight);

  const leftMarginMm = mmFromRdlSize(firstTextContentByTagNS(parsed, 'LeftMargin') ?? '0cm') || 0;
  const topMarginMm = mmFromRdlSize(firstTextContentByTagNS(parsed, 'TopMargin') ?? '0cm') || 0;
  const rightMarginMm = mmFromRdlSize(firstTextContentByTagNS(parsed, 'RightMargin') ?? '0cm') || 0;
  const bottomMarginMm =
    mmFromRdlSize(firstTextContentByTagNS(parsed, 'BottomMargin') ?? '0cm') || 0;

  const sectionEl = parsed.getElementsByTagNameNS('*', 'ReportSection').item(0);
  if (!sectionEl) {
    return {
      page: { widthMm: 210, heightMm: 297 },
      headerHeightMm: 25,
      footerHeightMm: 25,
      elements: [],
    };
  }

  const headerEl = sectionEl.getElementsByTagNameNS('*', 'PageHeader').item(0) ?? null;
  const footerEl = sectionEl.getElementsByTagNameNS('*', 'PageFooter').item(0) ?? null;
  const bodyEl = sectionEl.getElementsByTagNameNS('*', 'Body').item(0) ?? null;

  const headerHeightMm = headerEl
    ? mmFromRdlSize(firstTextContentByTagNS(headerEl, 'Height') ?? '0cm') || 0
    : 0;
  const footerHeightMm = footerEl
    ? mmFromRdlSize(firstTextContentByTagNS(footerEl, 'Height') ?? '0cm') || 0
    : 0;

  const embedded = buildEmbeddedImagesMap(parsed);

  const elements: LaymaElement[] = [];

  const headerItems = headerEl ? reportItemsElement(sectionEl, 'PageHeader') : null;
  if (headerItems) {
    const offsetMm = { xMm: leftMarginMm, yMm: topMarginMm };
    elements.push(...importReportItems(headerItems, offsetMm, embedded, 'InvoiceHeader', 'header'));
  }

  const bodyItems = bodyEl ? reportItemsElement(sectionEl, 'Body') : null;
  if (bodyItems) {
    const offsetMm = { xMm: leftMarginMm, yMm: topMarginMm + headerHeightMm };
    elements.push(...importReportItems(bodyItems, offsetMm, embedded, 'InvoiceLine', 'body'));
  }

  const footerItems = footerEl ? reportItemsElement(sectionEl, 'PageFooter') : null;
  if (footerItems) {
    const yBase = pageHeightMm - bottomMarginMm - footerHeightMm;
    const offsetMm = { xMm: leftMarginMm, yMm: yBase };
    elements.push(...importReportItems(footerItems, offsetMm, embedded, 'InvoiceFooter', 'footer'));
  }

  const cleanPageWidthMm = Number.isFinite(pageWidthMm) ? pageWidthMm : 210;
  const cleanPageHeightMm = Number.isFinite(pageHeightMm) ? pageHeightMm : 297;

  return {
    page: {
      widthMm: cleanPageWidthMm,
      heightMm: cleanPageHeightMm,
    },
    headerHeightMm: headerHeightMm > 0 ? headerHeightMm : 25,
    footerHeightMm: footerHeightMm > 0 ? footerHeightMm : 25,
    elements,
  };
}

function importReportItems(
  reportItemsEl: Element,
  offsetMm: { xMm: number; yMm: number },
  embedded: Map<string, string>,
  datasetHint: string,
  section: LaymaSection
): LaymaElement[] {
  const out: LaymaElement[] = [];
  for (const child of Array.from(reportItemsEl.children)) {
    if (child.localName === 'Textbox') {
      const el = importTextbox(child, offsetMm, datasetHint, section);
      if (el) out.push(el);
      continue;
    }
    if (child.localName === 'Image') {
      const el = importImage(child, offsetMm, embedded, datasetHint, section);
      if (el) out.push(el);
      continue;
    }
    if (child.localName === 'Line') {
      const el = importLine(child, offsetMm, section);
      if (el) out.push(el);
      continue;
    }
    if (child.localName === 'Tablix') {
      const el = importTablixAsTable(child, offsetMm, datasetHint, section);
      if (el) out.push(el);
      continue;
    }
  }
  return out;
}
