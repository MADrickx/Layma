import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type {
  LaymaElement,
  LaymaFontWeight,
  LaymaImageElement,
  LaymaLineElement,
  LaymaRectElement,
  LaymaTableCell,
  LaymaTableCellStyle,
  LaymaTableElement,
  LaymaTextAlign,
  LaymaTextElement,
} from '../model/model';

type LaymaPropsSectionId =
  | 'position'
  | 'layer'
  | 'text'
  | 'rect'
  | 'line'
  | 'image'
  | 'table'
  | 'delete';

export interface LaymaPropsEvent {
  readonly propName: string;
  readonly value: unknown;
}

@Component({
  selector: 'layma-props',
  standalone: true,
  imports: [],
  templateUrl: './layma-props.component.html',
  styleUrl: './layma-props.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LaymaPropsComponent {
  private readonly openSections = signal<ReadonlySet<LaymaPropsSectionId>>(
    new Set<LaymaPropsSectionId>(['position', 'layer', 'text', 'rect', 'line', 'image', 'table', 'delete'])
  );

  isSectionOpen(id: LaymaPropsSectionId): boolean {
    return this.openSections().has(id);
  }

  toggleSection(id: LaymaPropsSectionId): void {
    this.openSections.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  readonly element = input.required<LaymaElement>();

  readonly asText = computed((): LaymaTextElement | null => {
    const el = this.element();
    return el.type === 'text' ? el : null;
  });

  readonly asRect = computed((): LaymaRectElement | null => {
    const el = this.element();
    return el.type === 'rect' ? el : null;
  });

  readonly asLine = computed((): LaymaLineElement | null => {
    const el = this.element();
    return el.type === 'line' ? el : null;
  });

  readonly asImage = computed((): LaymaImageElement | null => {
    const el = this.element();
    return el.type === 'image' ? el : null;
  });

  readonly asTable = computed((): LaymaTableElement | null => {
    const el = this.element();
    return el.type === 'table' ? el : null;
  });

  readonly propChange = output<LaymaPropsEvent>();
  readonly close = output<void>();
  readonly deleteElement = output<void>();
  readonly reorder = output<'forward' | 'backward' | 'front' | 'back'>();
  readonly replaceImage = output<void>();
  readonly imageFitChange = output<LaymaImageElement['objectFit']>();

  private tableCellPropName(kind: 'header' | 'rowTemplate' | 'footer'): 'header' | 'rowTemplate' | 'footer' {
    return kind;
  }

  tableCells(table: LaymaTableElement, kind: 'header' | 'rowTemplate' | 'footer'): readonly LaymaTableCell[] {
    const count = Math.max(1, table.columns.length);
    const current =
      kind === 'header' ? table.header : kind === 'footer' ? (table.footer ?? []) : table.rowTemplate;

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

  private patchTableCell(
    kind: 'header' | 'rowTemplate' | 'footer',
    index: number,
    patch: (cell: LaymaTableCell) => LaymaTableCell
  ): void {
    const table = this.asTable();
    if (!table) return;
    const cells = this.tableCells(table, kind);
    const next = cells.map((cell, i) => (i === index ? patch(cell) : cell));
    this.propChange.emit({ propName: this.tableCellPropName(kind), value: next });
  }

  private patchTableCellStyle(
    kind: 'header' | 'rowTemplate' | 'footer',
    index: number,
    patch: (style: LaymaTableCellStyle) => LaymaTableCellStyle
  ): void {
    this.patchTableCell(kind, index, (cell) => {
      const nextStyle = patch({ ...(cell.style ?? {}) });
      return { ...cell, style: nextStyle };
    });
  }

  onPropChange(propName: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;

    const rawValue = target.value;
    const numericProps = new Set([
      'xMm',
      'yMm',
      'widthMm',
      'heightMm',
      'fontSizePt',
      'paddingMm',
      'borderWidthMm',
      'borderRadiusMm',
      'opacity',
    ]);

    const parsedValue = numericProps.has(propName) ? Number(rawValue) : rawValue;
    if (typeof parsedValue === 'number' && !Number.isFinite(parsedValue)) return;

    this.propChange.emit({ propName, value: parsedValue });
  }

  onPropCheckboxChange(propName: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.propChange.emit({ propName, value: target.checked });
  }

  onImageFitChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = target.value;
    if (value !== 'contain' && value !== 'cover' && value !== 'fill' && value !== 'none') return;
    this.imageFitChange.emit(value);
  }

  onTableColumnCountChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const table = this.asTable();
    if (!table) return;
    const count = Math.max(1, Math.round(Number(target.value)));
    if (!Number.isFinite(count)) return;

    const totalWidth = table.widthMm;
    const widthMm = totalWidth / count;
    const nextColumns = Array.from({ length: count }, (_, i) => ({
      widthMm,
      align: table.columns[i]?.align ?? 'left',
    }));

    const nextHeader = Array.from({ length: count }, (_, i) => ({
      text: table.header[i]?.text ?? `Header${i + 1}`,
      isHeader: true,
      style: table.header[i]?.style,
    }));

    const nextRow = Array.from({ length: count }, (_, i) => ({
      text: table.rowTemplate[i]?.text ?? `#InvoiceLine_Field${i + 1}#`,
      isHeader: false,
      style: table.rowTemplate[i]?.style,
    }));

    const nextFooter = Array.from({ length: count }, (_, i) => ({
      text: table.footer?.[i]?.text ?? `#InvoiceLine_Field${i + 1}#`,
      isHeader: false,
      style: table.footer?.[i]?.style,
    }));

    this.propChange.emit({ propName: 'columns', value: nextColumns });
    this.propChange.emit({ propName: 'header', value: nextHeader });
    this.propChange.emit({ propName: 'footer', value: nextFooter });
    this.propChange.emit({ propName: 'rowTemplate', value: nextRow });
  }

  onTableHeaderChange(index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const table = this.asTable();
    if (!table) return;
    const next = table.header.map((cell, i) =>
      i === index ? { ...cell, text: target.value } : cell
    );
    this.propChange.emit({ propName: 'header', value: next });
  }

  onTableRowTagChange(index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const table = this.asTable();
    if (!table) return;
    const next = table.rowTemplate.map((cell, i) =>
      i === index ? { ...cell, text: target.value } : cell
    );
    this.propChange.emit({ propName: 'rowTemplate', value: next });
  }

  onTableCellTextChange(kind: 'header' | 'rowTemplate' | 'footer', index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.patchTableCell(kind, index, (cell) => ({ ...cell, text: target.value }));
  }

  onTableCellAlignChange(kind: 'header' | 'rowTemplate' | 'footer', index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = target.value;
    if (value !== 'left' && value !== 'center' && value !== 'right') return;
    this.patchTableCellStyle(kind, index, (style) => ({ ...style, align: value as LaymaTextAlign }));
  }

  onTableCellBoldChange(kind: 'header' | 'rowTemplate' | 'footer', index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const weight: LaymaFontWeight = target.checked ? 'bold' : 'normal';
    this.patchTableCellStyle(kind, index, (style) => ({ ...style, fontWeight: weight }));
  }

  onTableCellBorderColorChange(kind: 'header' | 'rowTemplate' | 'footer', index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.patchTableCellStyle(kind, index, (style) => ({ ...style, borderColor: target.value }));
  }

  onTableCellBorderWidthChange(kind: 'header' | 'rowTemplate' | 'footer', index: number, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const value = Number(target.value);
    if (!Number.isFinite(value) || value < 0) return;
    this.patchTableCellStyle(kind, index, (style) => ({ ...style, borderWidthMm: value }));
  }
}
