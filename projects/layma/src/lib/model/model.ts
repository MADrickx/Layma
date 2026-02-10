export type LaymaElementType = 'text' | 'rect' | 'line' | 'image' | 'table';

export type LaymaElementId = string;

export type LaymaSection = 'header' | 'body' | 'footer';

export interface LaymaPage {
  /**
   * Use millimeters for stable export to A4/PDF.
   * A4 portrait is 210mm x 297mm.
   */
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface LaymaDocument {
  readonly page: LaymaPage;
  /** Header height in mm, measured from top. */
  readonly headerHeightMm: number;
  /** Footer height in mm, measured from bottom. */
  readonly footerHeightMm: number;
  readonly elements: readonly LaymaElement[];
}

export interface LaymaElementBase {
  readonly id: LaymaElementId;
  readonly type: LaymaElementType;
  readonly section: LaymaSection;
  /** Top-left position in mm relative to page origin. */
  readonly xMm: number;
  readonly yMm: number;
  /** Size in mm. */
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface LaymaTextElement extends LaymaElementBase {
  readonly type: 'text';
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly color: string;
  readonly align: 'left' | 'center' | 'right';
  /** Uniform padding on all four sides, in mm. */
  readonly paddingMm: number;
}

export interface LaymaRectElement extends LaymaElementBase {
  readonly type: 'rect';
  readonly fillColor: string;
  readonly borderColor: string;
  readonly borderWidthMm: number;
  readonly borderRadiusMm: number;
}

export interface LaymaLineElement extends LaymaElementBase {
  readonly type: 'line';
  readonly color: string;
}

export interface LaymaImageElement extends LaymaElementBase {
  readonly type: 'image';
  /** Data URI: data:image/png;base64,... */
  readonly dataUri: string;
  readonly objectFit: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity: number;
  readonly borderRadiusMm: number;
  readonly aspectRatioLocked: boolean;
}

export interface LaymaTableColumn {
  readonly widthMm: number;
  readonly align: 'left' | 'center' | 'right';
}

export interface LaymaTableCell {
  readonly text: string;
  readonly isHeader: boolean;
}

export interface LaymaTableElement extends LaymaElementBase {
  readonly type: 'table';
  readonly columns: readonly LaymaTableColumn[];
  readonly header: readonly LaymaTableCell[];
  readonly rowTemplate: readonly LaymaTableCell[];
  /** Optional dataset binding for the template row. */
  readonly tableDataset?: string;
  readonly borderColor: string;
  readonly borderWidthMm: number;
  readonly headerBackground: string;
}

export type LaymaElement =
  | LaymaTextElement
  | LaymaRectElement
  | LaymaLineElement
  | LaymaImageElement
  | LaymaTableElement;

export const A4_PORTRAIT_PAGE: LaymaPage = Object.freeze({ widthMm: 210, heightMm: 297 });

export function createEmptyDocument(): LaymaDocument {
  return {
    page: A4_PORTRAIT_PAGE,
    headerHeightMm: 25,
    footerHeightMm: 25,
    elements: [],
  };
}

export function createLaymaElementId(): LaymaElementId {
  const cryptoObj: Crypto | undefined = typeof crypto === 'object' ? crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback: still unique enough for local MVP usage.
  return `layma_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createDefaultTextElement(boxMm: {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}): LaymaTextElement {
  const normalized = normalizeBoxMm(boxMm);
  return {
    id: createLaymaElementId(),
    type: 'text',
    section: 'body',
    ...normalized,
    text: 'Text',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSizePt: 12,
    color: '#111',
    align: 'left',
    paddingMm: 1,
  };
}

export function createDefaultRectElement(boxMm: {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}): LaymaRectElement {
  const normalized = normalizeBoxMm(boxMm);
  return {
    id: createLaymaElementId(),
    type: 'rect',
    section: 'body',
    ...normalized,
    fillColor: 'transparent',
    borderColor: '#111',
    borderWidthMm: 0.3,
    borderRadiusMm: 0,
  };
}

export function createDefaultLineElement(boxMm: {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}): LaymaLineElement {
  const normalized = normalizeBoxMm(boxMm);
  // Ensure line is visible even when clicked.
  const minThicknessMm = 0.3;
  const widthMm = Math.max(normalized.widthMm, minThicknessMm);
  const heightMm = Math.max(normalized.heightMm, minThicknessMm);
  return {
    id: createLaymaElementId(),
    type: 'line',
    section: 'body',
    xMm: normalized.xMm,
    yMm: normalized.yMm,
    widthMm,
    heightMm,
    color: '#111',
  };
}

export function createDefaultImageElement(
  boxMm: {
    readonly xMm: number;
    readonly yMm: number;
    readonly widthMm: number;
    readonly heightMm: number;
  },
  dataUri: string
): LaymaImageElement {
  const normalized = normalizeBoxMm(boxMm);
  return {
    id: createLaymaElementId(),
    type: 'image',
    section: 'body',
    ...normalized,
    dataUri,
    objectFit: 'contain',
    opacity: 1,
    borderRadiusMm: 0,
    aspectRatioLocked: true,
  };
}

export function createDefaultTableElement(boxMm: {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}): LaymaTableElement {
  const normalized = normalizeBoxMm(boxMm);
  return {
    id: createLaymaElementId(),
    type: 'table',
    section: 'body',
    ...normalized,
    columns: [
      { widthMm: normalized.widthMm / 2, align: 'left' },
      { widthMm: normalized.widthMm / 2, align: 'left' },
    ],
    header: [
      { text: 'Header1', isHeader: true },
      { text: 'Header2', isHeader: true },
    ],
    rowTemplate: [
      { text: '#InvoiceLine_Field1#', isHeader: false },
      { text: '#InvoiceLine_Field2#', isHeader: false },
    ],
    borderColor: '#cbd5e1',
    borderWidthMm: 0.3,
    headerBackground: '#f3f4f6',
  };
}

export function clampMm(valueMm: number, minMm: number, maxMm: number): number {
  return Math.max(minMm, Math.min(maxMm, valueMm));
}

export function normalizeBoxMm(box: {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}): { xMm: number; yMm: number; widthMm: number; heightMm: number } {
  const xMm = box.widthMm >= 0 ? box.xMm : box.xMm + box.widthMm;
  const yMm = box.heightMm >= 0 ? box.yMm : box.yMm + box.heightMm;
  const widthMm = Math.abs(box.widthMm);
  const heightMm = Math.abs(box.heightMm);
  return { xMm, yMm, widthMm, heightMm };
}
