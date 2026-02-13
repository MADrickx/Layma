import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { NgClass, NgStyle } from '@angular/common';

import {
  A4_PORTRAIT_PAGE,
  type LaymaDocument,
  type LaymaElement,
  type LaymaElementId,
  type LaymaImageElement,
  type LaymaSection,
  type LaymaTableCell,
  type LaymaTableColumn,
  type LaymaTableElement,
  type LaymaTableEntityBinding,
  createDefaultLineElement,
  createDefaultImageElement,
  createDefaultRectElement,
  createDefaultTextElement,
  createDefaultTableElement,
  createEmptyDocument,
  normalizeBoxMm,
} from '../model/model';

import { LaymaPropsComponent, type LaymaPropsEvent } from '../layma-props/layma-props.component';

import { snapBoxMm, snapMm } from '../editor/snap';
import { readFileAsDataUri } from '../images/image-import';
import { exportDocumentToHtml } from '../export/export-html';
import { importRdlToLaymaDocument } from '../import/rdl/rdl-import';

type LaymaTool = 'select' | 'text' | 'rect' | 'line' | 'image' | 'table';
type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

function normalizeEntityKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function reconcileImportedTableBindings(
  doc: LaymaDocument,
  bindings: readonly LaymaTableEntityBinding[]
): LaymaDocument {
  if (bindings.length === 0) return doc;

  const byMain = new Map<string, LaymaTableEntityBinding>();
  for (const b of bindings) {
    const key = normalizeEntityKey(b.mainEntity);
    if (!key) continue;
    if (!byMain.has(key)) byMain.set(key, b);
  }

  const findRepeatableExact = (b: LaymaTableEntityBinding, repeatable: string): string | undefined => {
    const target = normalizeEntityKey(repeatable);
    if (!target) return undefined;
    for (const opt of b.repeatableEntity) {
      if (normalizeEntityKey(opt) === target) return opt;
    }
    return undefined;
  };

  const findBindingByRepeatable = (repeatable: string): LaymaTableEntityBinding | undefined => {
    const target = normalizeEntityKey(repeatable);
    if (!target) return undefined;
    for (const b of bindings) {
      for (const opt of b.repeatableEntity) {
        if (normalizeEntityKey(opt) === target) return b;
      }
    }
    return undefined;
  };

  const elements = doc.elements.map((el): LaymaElement => {
    if (el.type !== 'table') return el;

    const currentMain = el.tableMainType ?? '';
    const currentRepeatable = el.tableRepeatableType ?? el.tableDataset ?? '';

    // 1) Prefer matching by main entity, then normalize repeatable under that binding.
    const mainBinding = byMain.get(normalizeEntityKey(currentMain));
    if (mainBinding) {
      const repeatableExact = findRepeatableExact(mainBinding, currentRepeatable);
      return {
        ...el,
        tableMainType: mainBinding.mainEntity,
        tableRepeatableType: repeatableExact ?? el.tableRepeatableType,
        tableDataset: repeatableExact ?? el.tableDataset,
      };
    }

    // 2) If main didn't match, but repeatable matches some binding option, adopt that binding.
    const repeatableBinding = findBindingByRepeatable(currentRepeatable);
    if (repeatableBinding) {
      const repeatableExact = findRepeatableExact(repeatableBinding, currentRepeatable);
      return {
        ...el,
        tableMainType: repeatableBinding.mainEntity,
        tableRepeatableType: repeatableExact ?? el.tableRepeatableType,
        tableDataset: repeatableExact ?? el.tableDataset,
      };
    }

    // 3) No match: leave as-is.
    return el;
  });

  return { ...doc, elements };
}

interface DragStateNone {
  readonly kind: 'none';
}

interface DragStateMove {
  readonly kind: 'move';
  readonly elementId: LaymaElementId;
  readonly startPointerMm: { readonly xMm: number; readonly yMm: number };
  readonly startElementMm: { readonly xMm: number; readonly yMm: number };
}

interface DragStateResize {
  readonly kind: 'resize';
  readonly elementId: LaymaElementId;
  readonly handle: ResizeHandle;
  readonly startPointerMm: { readonly xMm: number; readonly yMm: number };
  readonly startBoxMm: {
    readonly xMm: number;
    readonly yMm: number;
    readonly widthMm: number;
    readonly heightMm: number;
  };
}

interface DragStateCreate {
  readonly kind: 'create';
  readonly tool: Exclude<LaymaTool, 'select'>;
  readonly elementId: LaymaElementId;
  readonly startPointerMm: { readonly xMm: number; readonly yMm: number };
}

interface DragStateMarquee {
  readonly kind: 'marquee';
  readonly startPointerMm: { readonly xMm: number; readonly yMm: number };
}

interface DragStateMultiMove {
  readonly kind: 'multi-move';
  readonly elementIds: ReadonlySet<LaymaElementId>;
  readonly startPointerMm: { readonly xMm: number; readonly yMm: number };
  readonly startPositions: ReadonlyMap<
    LaymaElementId,
    { readonly xMm: number; readonly yMm: number }
  >;
}

type TableCellKind = 'header' | 'row' | 'footer';
interface TableCellEdit {
  readonly elementId: LaymaElementId;
  readonly kind: TableCellKind;
  readonly index: number;
}

type DragState =
  | DragStateNone
  | DragStateMove
  | DragStateResize
  | DragStateCreate
  | DragStateMarquee
  | DragStateMultiMove;

@Component({
  selector: 'layma-editor',
  standalone: true,
  imports: [NgClass, NgStyle, LaymaPropsComponent],
  templateUrl: './layma-editor.component.html',
  styleUrl: './layma-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LaymaEditorComponent {
  private readonly destroyRef = inject(DestroyRef);

  // ── Inputs ──

  /**
   * The document model driving the editor.
   * Contains the page dimensions and the full list of elements (text, rect, line, image, table).
   * Bind two-way with `(documentChange)` to keep the host in sync.
   * If not provided, starts with an empty A4 portrait document.
   */
  readonly document = input<LaymaDocument>(createEmptyDocument());

  /**
   * CSS scale factor applied to the A4 page surface.
   * `1` = actual mm-based size; `0.5` = half size; `2` = double.
   * Interactions (drag, resize, snap) compensate for zoom automatically.
   */
  readonly zoom = input<number>(1);

  /**
   * Grid cell size in millimeters.
   * Controls both the visible dot grid and the snapping increment.
   * Typical values: 1, 2.5, 5.
   */
  readonly gridSizeMm = input<number>(5);

  /**
   * When `true`, element positions and sizes snap to the nearest `gridSizeMm` multiple
   * during drag, resize, create, and arrow-key nudge.
   */
  readonly snapEnabled = input<boolean>(true);

  /**
   * Host-provided entity bindings for table export metadata.
   * Used by the table props UI to offer dependent dropdowns.
   */
  readonly tableEntityBindings = input<readonly LaymaTableEntityBinding[]>([]);

  // ── Outputs ──

  /**
   * Emitted every time the document model changes (element added, moved, resized, deleted, property edited, etc.).
   * Bind to this to keep a parent-owned signal / store in sync:
   * `(documentChange)="myDoc.set($event)"`
   */
  readonly documentChange = output<LaymaDocument>();

  /**
   * Emitted when the user clicks "Export HTML".
   * Contains the full self-contained HTML string (with `<style>` in head and base64 images inline).
   * Useful if the host wants to post-process or upload the HTML instead of just downloading it.
   */
  readonly exportHtml = output<string>();

  // ── View children (internal template refs) ──

  readonly pageEl = viewChild.required<ElementRef<HTMLElement>>('page');
  readonly fileInputEl = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  readonly rdlInputEl = viewChild.required<ElementRef<HTMLInputElement>>('rdlInput');

  private readonly documentState = signal<LaymaDocument>(createEmptyDocument());

  readonly tool = signal<LaymaTool>('select');
  readonly selectedElementIds = signal<ReadonlySet<LaymaElementId>>(new Set());
  readonly dragState = signal<DragState>({ kind: 'none' });
  readonly pendingImageDataUri = signal<string | null>(null);
  readonly brokenImageIds = signal<ReadonlySet<LaymaElementId>>(new Set());
  readonly editingTextId = signal<LaymaElementId | null>(null);
  readonly editingTableCell = signal<TableCellEdit | null>(null);
  readonly marqueeEndMm = signal<{ readonly xMm: number; readonly yMm: number } | null>(null);
  readonly activeSection = signal<LaymaSection>('body');
  private replaceMode = false;

  private latestPointerEvent: PointerEvent | null = null;
  private rafId: number | null = null;
  private isDragging = false;

  readonly elements = computed(() => this.documentState().elements);

  readonly hasInvalidTableBindings = computed((): boolean => {
    for (const el of this.documentState().elements) {
      if (el.type !== 'table') continue;
      if (!el.tableMainType?.trim()) return true;
      if (!el.tableRepeatableType?.trim()) return true;
    }
    return false;
  });

  readonly exportHtmlDisabledTitle = computed((): string => {
    if (!this.hasInvalidTableBindings()) return 'Export HTML';
    return 'Export disabled: select Table main entity and repeatable entity in the Properties panel.';
  });

  tableCells(el: LaymaTableElement, kind: 'header' | 'rowTemplate' | 'footer'): readonly LaymaTableCell[] {
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

  tablePreviewCellStyle(
    table: LaymaTableElement,
    cell: LaymaTableCell,
    kind: 'header' | 'rowTemplate' | 'footer',
    colIndex: number
  ): Record<string, string> {
    const borderColor = cell.style?.borderColor ?? table.borderColor;
    const borderWidthMm = cell.style?.borderWidthMm ?? table.borderWidthMm;
    const fontWeight = cell.style?.fontWeight ?? (kind === 'header' ? 'bold' : 'normal');
    const textAlign = cell.style?.align ?? table.columns[colIndex]?.align ?? 'left';
    const style: Record<string, string> = {
      borderColor,
      borderWidth: `${borderWidthMm}mm`,
      borderStyle: 'solid',
      fontWeight,
      textAlign,
    };
    if (kind === 'header') style['background'] = table.headerBackground;
    if (kind === 'footer') style['background'] = table.footerBackground;
    return style;
  }

  readonly sectionHeights = computed(() => {
    const doc = this.documentState();
    const pageH = doc.page?.heightMm ?? A4_PORTRAIT_PAGE.heightMm;
    const header = Math.max(0, Math.min(pageH, doc.headerHeightMm ?? 0));
    const footer = Math.max(0, Math.min(pageH - header, doc.footerHeightMm ?? 0));
    const body = Math.max(0, pageH - header - footer);
    return {
      headerHeightMm: header,
      footerHeightMm: footer,
      bodyHeightMm: body,
      pageHeightMm: pageH,
    };
  });

  private sectionBoundsMm(section: LaymaSection): { topMm: number; bottomMm: number } {
    const { headerHeightMm, footerHeightMm, pageHeightMm } = this.sectionHeights();
    if (section === 'header') return { topMm: 0, bottomMm: headerHeightMm };
    if (section === 'footer')
      return { topMm: pageHeightMm - footerHeightMm, bottomMm: pageHeightMm };
    return { topMm: headerHeightMm, bottomMm: pageHeightMm - footerHeightMm };
  }

  private isPointerInActiveSection(pointerMm: { xMm: number; yMm: number }): boolean {
    const b = this.sectionBoundsMm(this.activeSection());
    return pointerMm.yMm >= b.topMm && pointerMm.yMm <= b.bottomMm;
  }

  setActiveSection(section: LaymaSection): void {
    this.activeSection.set(section);
    this.clearSelection();
    this.dragState.set({ kind: 'none' });
  }

  private normalizeTableColumns(
    columns: readonly LaymaTableColumn[],
    widthMm: number
  ): LaymaTableColumn[] {
    if (columns.length === 0) return [];
    const w = widthMm / columns.length;
    return columns.map((col) => ({ ...col, widthMm: w }));
  }

  onZoneDblClick(event: MouseEvent, section: LaymaSection): void {
    event.stopPropagation();
    this.setActiveSection(section);
  }

  readonly headerZoneStyle = computed(() => {
    const doc = this.documentState();
    const page = doc.page ?? A4_PORTRAIT_PAGE;
    const { headerHeightMm } = this.sectionHeights();
    return { left: '0mm', top: '0mm', width: `${page.widthMm}mm`, height: `${headerHeightMm}mm` };
  });

  readonly bodyZoneStyle = computed(() => {
    const doc = this.documentState();
    const page = doc.page ?? A4_PORTRAIT_PAGE;
    const { headerHeightMm, bodyHeightMm } = this.sectionHeights();
    return {
      left: '0mm',
      top: `${headerHeightMm}mm`,
      width: `${page.widthMm}mm`,
      height: `${bodyHeightMm}mm`,
    };
  });

  readonly footerZoneStyle = computed(() => {
    const doc = this.documentState();
    const page = doc.page ?? A4_PORTRAIT_PAGE;
    const { footerHeightMm, pageHeightMm } = this.sectionHeights();
    return {
      left: '0mm',
      top: `${pageHeightMm - footerHeightMm}mm`,
      width: `${page.widthMm}mm`,
      height: `${footerHeightMm}mm`,
    };
  });

  /** All selected elements. */
  readonly selectedElements = computed((): readonly LaymaElement[] => {
    const ids = this.selectedElementIds();
    if (ids.size === 0) return [];
    return this.documentState().elements.filter((el) => ids.has(el.id));
  });

  /** Single selected element (for the props panel) — null when 0 or 2+ are selected. */
  readonly selectedElement = computed((): LaymaElement | null => {
    const els = this.selectedElements();
    return els.length === 1 ? els[0] : null;
  });

  /** Convenience: first selected id (for resize handles, image replace, etc.). */
  readonly primarySelectedId = computed((): LaymaElementId | null => {
    const ids = this.selectedElementIds();
    if (ids.size === 0) return null;
    return ids.values().next().value ?? null;
  });

  isElementSelected(id: LaymaElementId): boolean {
    return this.selectedElementIds().has(id);
  }

  /** Bounding box of all selected elements — used for the blue selection outline. */
  readonly selectionBoxStyle = computed(() => {
    const els = this.selectedElements();
    if (els.length === 0) return null;
    const minX = Math.min(...els.map((el) => el.xMm));
    const minY = Math.min(...els.map((el) => el.yMm));
    const maxX = Math.max(...els.map((el) => el.xMm + el.widthMm));
    const maxY = Math.max(...els.map((el) => el.yMm + el.heightMm));
    return {
      left: `${minX}mm`,
      top: `${minY}mm`,
      width: `${maxX - minX}mm`,
      height: `${maxY - minY}mm`,
    };
  });

  /** Live marquee rectangle style while the user is drawing. */
  readonly marqueeStyle = computed(() => {
    const drag = this.dragState();
    if (drag.kind !== 'marquee') return null;
    const end = this.marqueeEndMm();
    if (!end) return null;
    const box = normalizeBoxMm({
      xMm: drag.startPointerMm.xMm,
      yMm: drag.startPointerMm.yMm,
      widthMm: end.xMm - drag.startPointerMm.xMm,
      heightMm: end.yMm - drag.startPointerMm.yMm,
    });
    return {
      left: `${box.xMm}mm`,
      top: `${box.yMm}mm`,
      width: `${box.widthMm}mm`,
      height: `${box.heightMm}mm`,
    };
  });

  constructor() {
    effect(() => {
      // Mirror the input into internal state. If the host doesn't bind two-way, the editor still works.
      this.documentState.set(this.document());
    });

    const onKeyDown = (event: KeyboardEvent): void => this.onGlobalKeyDown(event);
    window.addEventListener('keydown', onKeyDown);
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', onKeyDown));

    // If the host replaces the document, prune any selected ids that no longer exist.
    effect(() => {
      const ids = this.selectedElementIds();
      if (ids.size === 0) return;
      const elementIds = new Set(this.documentState().elements.map((el) => el.id));
      const pruned = new Set([...ids].filter((id) => elementIds.has(id)));
      if (pruned.size !== ids.size) this.selectedElementIds.set(pruned);
    });
  }

  setTool(tool: LaymaTool): void {
    this.tool.set(tool);
  }

  selectElement(elementId: LaymaElementId, additive = false): void {
    this.editingTextId.set(null);
    this.editingTableCell.set(null);
    if (additive) {
      const ids = new Set(this.selectedElementIds());
      if (ids.has(elementId)) ids.delete(elementId);
      else ids.add(elementId);
      this.selectedElementIds.set(ids);
    } else {
      this.selectedElementIds.set(new Set([elementId]));
    }
    this.tool.set('select');
  }

  clearSelection(): void {
    this.editingTextId.set(null);
    this.editingTableCell.set(null);
    this.selectedElementIds.set(new Set());
  }

  onTextDblClick(event: MouseEvent, elementId: LaymaElementId): void {
    event.stopPropagation();
    this.selectElement(elementId);
    this.editingTextId.set(elementId);
    this.editingTableCell.set(null);

    // Resolve the text content before Angular clears the binding (null during editing).
    const el = this.documentState().elements.find((e) => e.id === elementId);
    if (!el || el.type !== 'text') return;
    const text = el.text;

    const textEl = event.currentTarget;
    if (textEl instanceof HTMLElement) {
      // After Angular applies contenteditable and clears [textContent],
      // populate the element and focus. Runs before the next paint → no flash.
      requestAnimationFrame(() => {
        textEl.textContent = text;
        textEl.focus();
        // Place cursor at end of text.
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(textEl);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }
  }

  onTextBlur(event: FocusEvent, elementId: LaymaElementId): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const newText = (target.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    this.editingTextId.set(null);
    const doc = this.documentState();
    const elements = doc.elements.map((el) =>
      el.id === elementId && el.type === 'text' ? { ...el, text: newText } : el
    );
    this.applyDocument({ ...doc, elements });
  }

  onTextKeyDown(event: KeyboardEvent): void {
    // Prevent global shortcuts (arrow keys, delete) while typing.
    event.stopPropagation();
    // Escape exits editing without committing via blur.
    if (event.key === 'Escape') {
      (event.target as HTMLElement)?.blur();
    }
  }

  isEditingTableCell(elementId: LaymaElementId, kind: TableCellKind, index: number): boolean {
    const editing = this.editingTableCell();
    return (
      !!editing &&
      editing.elementId === elementId &&
      editing.kind === kind &&
      editing.index === index
    );
  }

  onTableCellDblClick(
    event: MouseEvent,
    elementId: LaymaElementId,
    kind: TableCellKind,
    index: number
  ): void {
    event.stopPropagation();
    this.selectElement(elementId);
    this.editingTextId.set(null);
    this.editingTableCell.set({ elementId, kind, index });

    const el = this.documentState().elements.find((e) => e.id === elementId);
    if (!el || el.type !== 'table') return;
    const text =
      kind === 'header'
        ? el.header[index]?.text ?? ''
        : kind === 'footer'
          ? el.footer?.[index]?.text ?? ''
          : el.rowTemplate[index]?.text ?? '';

    const cell = event.currentTarget;
    if (cell instanceof HTMLElement) {
      requestAnimationFrame(() => {
        cell.textContent = text;
        cell.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }
  }

  onTableCellBlur(
    event: FocusEvent,
    elementId: LaymaElementId,
    kind: TableCellKind,
    index: number
  ): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const newText = (target.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    this.editingTableCell.set(null);
    const doc = this.documentState();
    const elements = doc.elements.map((el) => {
      if (el.id !== elementId || el.type !== 'table') return el;
      if (kind === 'header') {
        const header = el.header.map((cell, i) =>
          i === index ? { ...cell, text: newText } : cell
        );
        return { ...el, header };
      }
      if (kind === 'footer') {
        const count = el.columns.length;
        const current = el.footer ?? [];
        const footer = Array.from({ length: count }, (_, i) => ({
          text: current[i]?.text ?? '',
          isHeader: false,
        })).map((cell, i) => (i === index ? { ...cell, text: newText } : cell));
        return { ...el, footer };
      }
      const rowTemplate = el.rowTemplate.map((cell, i) =>
        i === index ? { ...cell, text: newText } : cell
      );
      return { ...el, rowTemplate };
    });
    this.applyDocument({ ...doc, elements });
  }

  onTableCellKeyDown(event: KeyboardEvent): void {
    this.onTextKeyDown(event);
  }

  deleteSelected(): void {
    const ids = this.selectedElementIds();
    if (ids.size === 0) return;
    const nextElements = this.documentState().elements.filter((el) => !ids.has(el.id));
    this.selectedElementIds.set(new Set());
    this.applyDocument({ ...this.documentState(), elements: nextElements });
  }

  bringForward(): void {
    this.reorderSelected((elements, index) => {
      if (index >= elements.length - 1) return elements;
      const copy = elements.slice();
      const tmp = copy[index];
      copy[index] = copy[index + 1];
      copy[index + 1] = tmp;
      return copy;
    });
  }

  sendBackward(): void {
    this.reorderSelected((elements, index) => {
      if (index <= 0) return elements;
      const copy = elements.slice();
      const tmp = copy[index];
      copy[index] = copy[index - 1];
      copy[index - 1] = tmp;
      return copy;
    });
  }

  bringToFront(): void {
    this.reorderSelected((elements, index) => {
      if (index >= elements.length - 1) return elements;
      const copy = elements.slice();
      const [el] = copy.splice(index, 1);
      copy.push(el);
      return copy;
    });
  }

  sendToBack(): void {
    this.reorderSelected((elements, index) => {
      if (index <= 0) return elements;
      const copy = elements.slice();
      const [el] = copy.splice(index, 1);
      copy.unshift(el);
      return copy;
    });
  }

  requestExport(): void {
    const html = this.exportHtmlString();
    this.exportHtml.emit(html);
    this.downloadHtml();
  }

  triggerImagePick(): void {
    this.fileInputEl().nativeElement.click();
  }

  triggerRdlPick(): void {
    this.rdlInputEl().nativeElement.click();
  }

  async onRdlFilePicked(): Promise<void> {
    const inputEl = this.rdlInputEl().nativeElement;
    const file = inputEl.files?.item(0) ?? null;
    inputEl.value = '';
    if (!file) return;

    const xmlText = await file.text();
    const imported = importRdlToLaymaDocument(xmlText);
    const reconciled = reconcileImportedTableBindings(imported, this.tableEntityBindings());

    // Snap every imported element to the current grid for a clean layout.
    const grid = this.gridSizeMm();
    const snappedElements = reconciled.elements.map((el) => {
      const snapped = snapBoxMm(el, grid);
      return { ...el, ...snapped };
    });

    this.selectedElementIds.set(new Set());
    this.tool.set('select');
    this.applyDocument({ ...reconciled, elements: snappedElements });
    this.activeSection.set('body');
  }

  async onImageFilePicked(): Promise<void> {
    const inputEl = this.fileInputEl().nativeElement;
    // Snapshot into a plain array *before* clearing; FileList becomes empty once value is reset.
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    inputEl.value = '';
    if (files.length === 0) {
      this.replaceMode = false; // User cancelled the picker.
      return;
    }

    // Replace mode: swap the selected image's dataUri instead of creating new elements.
    if (this.replaceMode) {
      this.replaceMode = false;
      const file = files[0];
      if (!file) return;
      const dataUri = await readFileAsDataUri(file);
      this.replaceSelectedImageData(dataUri);
      return;
    }

    // Multi-upload: convert all files and either queue for placement or create directly.
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    if (imageFiles.length === 1) {
      const dataUri = await readFileAsDataUri(imageFiles[0]);
      this.pendingImageDataUri.set(dataUri);
      this.tool.set('image');
      return;
    }

    // Multiple images: create them stacked with a small offset.
    const doc = this.documentState();
    const newElements: LaymaElement[] = [];
    const section = this.activeSection();
    const { topMm } = this.sectionBoundsMm(section);
    for (let i = 0; i < imageFiles.length; i++) {
      const dataUri = await readFileAsDataUri(imageFiles[i]);
      const offsetMm = i * 5;
      const el = createDefaultImageElement(
        { xMm: 10 + offsetMm, yMm: topMm + 10 + offsetMm, widthMm: 60, heightMm: 40 },
        dataUri
      );
      newElements.push({ ...el, section });
    }
    this.applyDocument({ ...doc, elements: [...doc.elements, ...newElements] });
    if (newElements.length > 0) {
      this.selectedElementIds.set(new Set([newElements[newElements.length - 1].id]));
    }
    this.tool.set('select');
  }

  replaceSelectedImage(): void {
    const sel = this.selectedElement();
    if (!sel || sel.type !== 'image') return;
    this.replaceMode = true;
    this.triggerImagePick();
  }

  private replaceSelectedImageData(dataUri: string): void {
    const selectedId = this.primarySelectedId();
    if (!selectedId) return;
    const doc = this.documentState();
    const elements = doc.elements.map((el) =>
      el.id === selectedId && el.type === 'image' ? { ...el, dataUri } : el
    );
    // Clear broken state for this id.
    const broken = new Set(this.brokenImageIds());
    broken.delete(selectedId);
    this.brokenImageIds.set(broken);
    this.applyDocument({ ...doc, elements });
  }

  onImageError(elementId: LaymaElementId): void {
    const next = new Set(this.brokenImageIds());
    next.add(elementId);
    this.brokenImageIds.set(next);
  }

  isImageBroken(elementId: LaymaElementId): boolean {
    return this.brokenImageIds().has(elementId);
  }

  onStageDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  async onStageDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const dropMm = this.clientToPageMm(event.clientX, event.clientY);
    const doc = this.documentState();
    const newElements: LaymaElement[] = [];
    const section = this.activeSection();
    const { topMm } = this.sectionBoundsMm(section);

    if (dropMm && !this.isPointerInActiveSection(dropMm)) return;

    for (let i = 0; i < imageFiles.length; i++) {
      const dataUri = await readFileAsDataUri(imageFiles[i]);
      const offsetMm = i * 5;
      const xMm = dropMm ? dropMm.xMm + offsetMm : 10 + offsetMm;
      const yMm = dropMm ? dropMm.yMm + offsetMm : topMm + 10 + offsetMm;
      const el = createDefaultImageElement({ xMm, yMm, widthMm: 60, heightMm: 40 }, dataUri);
      newElements.push({ ...el, section });
    }

    this.applyDocument({ ...doc, elements: [...doc.elements, ...newElements] });
    if (newElements.length > 0) {
      this.selectedElementIds.set(new Set([newElements[newElements.length - 1].id]));
    }
    this.tool.set('select');
  }

  onPagePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    const tool = this.tool();

    if (tool === 'select') {
      // Start marquee selection rectangle on the page background.
      const startPointerMm = this.pointerToPageMm(event);
      if (!startPointerMm) {
        this.clearSelection();
        return;
      }
      if (!this.isPointerInActiveSection(startPointerMm)) {
        this.clearSelection();
        return;
      }
      this.clearSelection();
      this.marqueeEndMm.set(startPointerMm);
      this.dragState.set({ kind: 'marquee', startPointerMm });
      this.beginGlobalPointerTracking(event);
      return;
    }

    // Creation starts on page background.
    const startPointerMm = this.pointerToPageMm(event);
    if (!startPointerMm) return;
    if (!this.isPointerInActiveSection(startPointerMm)) return;

    const elementId = this.createElementForTool(tool, startPointerMm);
    if (!elementId) return;

    this.selectedElementIds.set(new Set([elementId]));
    this.dragState.set({ kind: 'create', tool, elementId, startPointerMm });
    this.beginGlobalPointerTracking(event);
  }

  onElementPointerDown(event: PointerEvent, elementId: LaymaElementId): void {
    if (event.button !== 0) return;

    // Always stop bubbling to the page handler. Otherwise, when a text/table cell is in edit mode
    // (and we early-return below), the page's pointerdown can start marquee/drag tracking which
    // breaks native text selection (click + drag) inside the contenteditable.
    event.stopPropagation();

    // While editing a text element, let clicks pass through.
    if (this.editingTextId() === elementId) return;
    const editingTable = this.editingTableCell();
    if (editingTable?.elementId === elementId) return;

    const additive = event.shiftKey;

    // If the element is already selected AND part of a multi-selection, start multi-move.
    if (this.isElementSelected(elementId) && this.selectedElementIds().size > 1 && !additive) {
      const pointerMm = this.pointerToPageMm(event);
      if (!pointerMm) return;
      const doc = this.documentState();
      const ids = this.selectedElementIds();
      const startPositions = new Map<LaymaElementId, { xMm: number; yMm: number }>();
      for (const el of doc.elements) {
        if (ids.has(el.id)) startPositions.set(el.id, { xMm: el.xMm, yMm: el.yMm });
      }
      this.dragState.set({
        kind: 'multi-move',
        elementIds: ids,
        startPointerMm: pointerMm,
        startPositions,
      });
      this.beginGlobalPointerTracking(event);
      return;
    }

    this.selectElement(elementId, additive);

    const pointerMm = this.pointerToPageMm(event);
    if (!pointerMm) return;

    // If after selection we have multiple elements, start multi-move.
    const ids = this.selectedElementIds();
    if (ids.size > 1) {
      const doc = this.documentState();
      const startPositions = new Map<LaymaElementId, { xMm: number; yMm: number }>();
      for (const el of doc.elements) {
        if (ids.has(el.id)) startPositions.set(el.id, { xMm: el.xMm, yMm: el.yMm });
      }
      this.dragState.set({
        kind: 'multi-move',
        elementIds: ids,
        startPointerMm: pointerMm,
        startPositions,
      });
      this.beginGlobalPointerTracking(event);
      return;
    }

    // Single element: standard move.
    const el = this.documentState().elements.find((e) => e.id === elementId);
    if (!el) return;

    this.dragState.set({
      kind: 'move',
      elementId,
      startPointerMm: pointerMm,
      startElementMm: { xMm: el.xMm, yMm: el.yMm },
    });
    this.beginGlobalPointerTracking(event);
  }

  onResizeHandlePointerDown(event: PointerEvent, handle: ResizeHandle): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const selectedId = this.primarySelectedId();
    if (!selectedId || this.selectedElementIds().size !== 1) return;

    const pointerMm = this.pointerToPageMm(event);
    if (!pointerMm) return;

    const el = this.documentState().elements.find((e) => e.id === selectedId);
    if (!el) return;

    this.dragState.set({
      kind: 'resize',
      elementId: selectedId,
      handle,
      startPointerMm: pointerMm,
      startBoxMm: { xMm: el.xMm, yMm: el.yMm, widthMm: el.widthMm, heightMm: el.heightMm },
    });
    this.beginGlobalPointerTracking(event);
  }

  elementStyle(el: LaymaElement, zIndex: number): Record<string, string> {
    const base: Record<string, string> = {
      left: `${el.xMm}mm`,
      top: `${el.yMm}mm`,
      width: `${el.widthMm}mm`,
      height: `${el.heightMm}mm`,
      zIndex: String(zIndex),
    };

    if (el.type === 'image') {
      if (el.opacity < 1) base['opacity'] = String(el.opacity);
      if (el.borderRadiusMm > 0) {
        base['borderRadius'] = `${el.borderRadiusMm}mm`;
        base['overflow'] = 'hidden';
      }
    }

    return base;
  }

  elementClass(el: LaymaElement): string {
    return `layma-element layma-element--${el.type}`;
  }

  private emitDocument(nextDocument: LaymaDocument): void {
    this.documentChange.emit(nextDocument);
  }

  private applyDocument(nextDocument: LaymaDocument): void {
    const elements = nextDocument.elements.map((el) => {
      if (el.type !== 'table') return el;
      const columns = this.normalizeTableColumns(el.columns, el.widthMm);
      return { ...el, columns };
    });
    const normalized = { ...nextDocument, elements };
    this.documentState.set(normalized);
    this.emitDocument(normalized);
  }

  readonly pageStyle = computed(() => {
    const page = this.documentState().page ?? A4_PORTRAIT_PAGE;
    return {
      width: `${page.widthMm}mm`,
      height: `${page.heightMm}mm`,
      transform: `scale(${this.zoom()})`,
    };
  });

  private pointerToPageMm(event: PointerEvent): { xMm: number; yMm: number } | null {
    return this.clientToPageMm(event.clientX, event.clientY);
  }

  private clientToPageMm(clientX: number, clientY: number): { xMm: number; yMm: number } | null {
    const page = this.pageEl().nativeElement;
    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const doc = this.documentState();
    const pageWidthMm = doc.page.widthMm;
    const pageHeightMm = doc.page.heightMm;

    const xPx = clientX - rect.left;
    const yPx = clientY - rect.top;
    const xMm = (xPx * pageWidthMm) / rect.width;
    const yMm = (yPx * pageHeightMm) / rect.height;
    return { xMm, yMm };
  }

  private createElementForTool(
    tool: LaymaTool,
    startPointerMm: { readonly xMm: number; readonly yMm: number }
  ): LaymaElementId | null {
    if (tool === 'select') return null;

    const seedBox = { xMm: startPointerMm.xMm, yMm: startPointerMm.yMm, widthMm: 1, heightMm: 1 };
    const section = this.activeSection();

    if (tool === 'image') {
      // Create with a placeholder; the real image is picked after the draw-to-size drag.
      const dataUri = this.pendingImageDataUri() ?? '';
      const el = { ...createDefaultImageElement(seedBox, dataUri), section };
      this.applyDocument({
        ...this.documentState(),
        elements: [...this.documentState().elements, el],
      });
      return el.id;
    }

    const el =
      tool === 'text'
        ? { ...createDefaultTextElement({ ...seedBox, widthMm: 40, heightMm: 10 }), section }
        : tool === 'rect'
        ? { ...createDefaultRectElement({ ...seedBox, widthMm: 40, heightMm: 25 }), section }
        : tool === 'line'
        ? { ...createDefaultLineElement({ ...seedBox, widthMm: 60, heightMm: 0.6 }), section }
        : { ...createDefaultTableElement({ ...seedBox, widthMm: 80, heightMm: 30 }), section };

    this.applyDocument({
      ...this.documentState(),
      elements: [...this.documentState().elements, el],
    });
    return el.id;
  }

  private beginGlobalPointerTracking(event: PointerEvent): void {
    if (this.isDragging) return;
    this.isDragging = true;

    const target = event.target;
    if (target instanceof Element) target.setPointerCapture?.(event.pointerId);

    this.latestPointerEvent = event;
    window.addEventListener('pointermove', this.onGlobalPointerMove, { passive: true });
    window.addEventListener('pointerup', this.onGlobalPointerUp, { passive: true });
    window.addEventListener('pointercancel', this.onGlobalPointerUp, { passive: true });
  }

  private readonly onGlobalPointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) return;
    this.latestPointerEvent = event;
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const latest = this.latestPointerEvent;
      if (!latest) return;
      this.applyDrag(latest);
    });
  };

  private readonly onGlobalPointerUp = (event: PointerEvent): void => {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.latestPointerEvent = null;

    const drag = this.dragState();

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Final apply on pointer up.
    this.applyDrag(event);

    if (drag.kind === 'marquee') {
      // Select all elements intersecting the marquee rectangle.
      const endMm = this.pointerToPageMm(event);
      if (endMm) {
        const box = normalizeBoxMm({
          xMm: drag.startPointerMm.xMm,
          yMm: drag.startPointerMm.yMm,
          widthMm: endMm.xMm - drag.startPointerMm.xMm,
          heightMm: endMm.yMm - drag.startPointerMm.yMm,
        });
        const ids = new Set<LaymaElementId>();
        for (const el of this.documentState().elements) {
          if (el.section !== this.activeSection()) continue;
          if (
            el.xMm < box.xMm + box.widthMm &&
            el.xMm + el.widthMm > box.xMm &&
            el.yMm < box.yMm + box.heightMm &&
            el.yMm + el.heightMm > box.yMm
          ) {
            ids.add(el.id);
          }
        }
        this.selectedElementIds.set(ids);
      }
      this.marqueeEndMm.set(null);
    }

    this.dragState.set({ kind: 'none' });

    if (drag.kind === 'create') {
      this.pendingImageDataUri.set(null);
      this.tool.set('select');

      // After drawing the image box, ask for the actual image file.
      if (drag.tool === 'image') {
        this.replaceMode = true;
        this.triggerImagePick();
      }
    }

    window.removeEventListener('pointermove', this.onGlobalPointerMove);
    window.removeEventListener('pointerup', this.onGlobalPointerUp);
    window.removeEventListener('pointercancel', this.onGlobalPointerUp);
  };

  private onGlobalKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      const isTypingTarget =
        target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (isTypingTarget) return;
    }

    const ids = this.selectedElementIds();
    if (ids.size === 0) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelected();
      return;
    }

    const key = event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown')
      return;

    event.preventDefault();

    const baseStepMm = this.snapEnabled() ? this.gridSizeMm() : 1;
    const stepMm = event.shiftKey ? baseStepMm * 5 : baseStepMm;

    const dxMm = key === 'ArrowLeft' ? -stepMm : key === 'ArrowRight' ? stepMm : 0;
    const dyMm = key === 'ArrowUp' ? -stepMm : key === 'ArrowDown' ? stepMm : 0;
    this.moveSelectedBy(dxMm, dyMm);
  }

  private moveSelectedBy(dxMm: number, dyMm: number): void {
    const ids = this.selectedElementIds();
    if (ids.size === 0) return;
    const doc = this.documentState();
    const page = doc.page;

    const elements = doc.elements.map((el) => {
      if (!ids.has(el.id)) return el;
      let nextX = el.xMm + dxMm;
      let nextY = el.yMm + dyMm;

      if (this.snapEnabled()) {
        const grid = this.gridSizeMm();
        nextX = snapMm(nextX, grid);
        nextY = snapMm(nextY, grid);
      }

      const maxX = Math.max(0, page.widthMm - el.widthMm);
      const { topMm, bottomMm } = this.sectionBoundsMm(el.section);
      const maxY = Math.max(topMm, bottomMm - el.heightMm);
      return {
        ...el,
        xMm: Math.max(0, Math.min(maxX, nextX)),
        yMm: Math.max(topMm, Math.min(maxY, nextY)),
      };
    });

    this.applyDocument({ ...doc, elements });
  }

  selectedImageObjectFit(): LaymaImageElement['objectFit'] | null {
    const el = this.selectedElement();
    return el?.type === 'image' ? el.objectFit : null;
  }

  setSelectedImageObjectFit(nextFit: LaymaImageElement['objectFit']): void {
    const selectedId = this.primarySelectedId();
    if (!selectedId) return;
    const doc = this.documentState();
    const elements = doc.elements.map((el) =>
      el.id === selectedId && el.type === 'image' ? { ...el, objectFit: nextFit } : el
    );
    this.applyDocument({ ...doc, elements });
  }

  onImageFitChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = target.value;
    if (value !== 'contain' && value !== 'cover' && value !== 'fill' && value !== 'none') return;
    this.setSelectedImageObjectFit(value);
  }

  /** Handle property changes emitted by the LaymaPropsComponent. */
  onPropsChange(event: LaymaPropsEvent): void {
    const ids = this.selectedElementIds();
    if (ids.size === 0) return;
    const doc = this.documentState();
    const elements = doc.elements.map((el) => {
      if (!ids.has(el.id)) return el;
      if (el.type !== 'table') return { ...el, [event.propName]: event.value };

      if (event.propName === 'widthMm' && typeof event.value === 'number') {
        const nextColumns = this.normalizeTableColumns(el.columns, event.value);
        return { ...el, widthMm: event.value, columns: nextColumns };
      }

      if (event.propName === 'columns' && Array.isArray(event.value)) {
        const nextColumns = this.normalizeTableColumns(
          event.value as LaymaTableColumn[],
          el.widthMm
        );
        return { ...el, columns: nextColumns };
      }

      return { ...el, [event.propName]: event.value };
    });
    this.applyDocument({ ...doc, elements });
  }

  onPropsReorder(direction: 'forward' | 'backward' | 'front' | 'back'): void {
    if (direction === 'forward') this.bringForward();
    else if (direction === 'backward') this.sendBackward();
    else if (direction === 'front') this.bringToFront();
    else this.sendToBack();
  }

  exportHtmlString(): string {
    return exportDocumentToHtml(this.documentState());
  }

  downloadHtml(filename = 'layma-layout.html'): void {
    const html = this.exportHtmlString();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private applyDrag(event: PointerEvent): void {
    const drag = this.dragState();
    if (drag.kind === 'none') return;

    const pointerMm = this.pointerToPageMm(event);
    if (!pointerMm) return;

    if (drag.kind === 'marquee') {
      this.marqueeEndMm.set(pointerMm);
      return;
    }

    if (drag.kind === 'multi-move') {
      this.applyMultiMove(drag, pointerMm);
      return;
    }

    if (drag.kind === 'move') {
      this.applyMove(drag, pointerMm);
      return;
    }

    if (drag.kind === 'resize') {
      this.applyResize(drag, pointerMm);
      return;
    }

    if (drag.kind === 'create') {
      this.applyCreate(drag, pointerMm);
    }
  }

  private applyMultiMove(
    drag: DragStateMultiMove,
    pointerMm: { readonly xMm: number; readonly yMm: number }
  ): void {
    const dxMm = pointerMm.xMm - drag.startPointerMm.xMm;
    const dyMm = pointerMm.yMm - drag.startPointerMm.yMm;
    const doc = this.documentState();
    const page = doc.page;

    const elements = doc.elements.map((el) => {
      const start = drag.startPositions.get(el.id);
      if (!start) return el;

      let nextX = start.xMm + dxMm;
      let nextY = start.yMm + dyMm;
      if (this.snapEnabled()) {
        const grid = this.gridSizeMm();
        nextX = snapMm(nextX, grid);
        nextY = snapMm(nextY, grid);
      }
      const maxX = Math.max(0, page.widthMm - el.widthMm);
      const { topMm, bottomMm } = this.sectionBoundsMm(el.section);
      const maxY = Math.max(topMm, bottomMm - el.heightMm);
      return {
        ...el,
        xMm: Math.max(0, Math.min(maxX, nextX)),
        yMm: Math.max(topMm, Math.min(maxY, nextY)),
      };
    });

    this.applyDocument({ ...doc, elements });
  }

  private applyMove(
    drag: DragStateMove,
    pointerMm: { readonly xMm: number; readonly yMm: number }
  ): void {
    const dxMm = pointerMm.xMm - drag.startPointerMm.xMm;
    const dyMm = pointerMm.yMm - drag.startPointerMm.yMm;

    const doc = this.documentState();
    const page = doc.page;
    const elements = doc.elements.map((el) => {
      if (el.id !== drag.elementId) return el;
      let nextX = drag.startElementMm.xMm + dxMm;
      let nextY = drag.startElementMm.yMm + dyMm;
      if (this.snapEnabled()) {
        const grid = this.gridSizeMm();
        nextX = snapMm(nextX, grid);
        nextY = snapMm(nextY, grid);
      }
      const maxX = Math.max(0, page.widthMm - el.widthMm);
      const { topMm, bottomMm } = this.sectionBoundsMm(el.section);
      const maxY = Math.max(topMm, bottomMm - el.heightMm);
      return {
        ...el,
        xMm: Math.max(0, Math.min(maxX, nextX)),
        yMm: Math.max(topMm, Math.min(maxY, nextY)),
      };
    });

    this.applyDocument({ ...doc, elements });
  }

  private applyResize(
    drag: DragStateResize,
    pointerMm: { readonly xMm: number; readonly yMm: number }
  ): void {
    const dxMm = pointerMm.xMm - drag.startPointerMm.xMm;
    const dyMm = pointerMm.yMm - drag.startPointerMm.yMm;

    const minSizeMm = 1;

    const box = { ...drag.startBoxMm };
    if (drag.handle.includes('w')) {
      box.xMm += dxMm;
      box.widthMm -= dxMm;
    }
    if (drag.handle.includes('e')) {
      box.widthMm += dxMm;
    }
    if (drag.handle.includes('n')) {
      box.yMm += dyMm;
      box.heightMm -= dyMm;
    }
    if (drag.handle.includes('s')) {
      box.heightMm += dyMm;
    }

    const normalized = normalizeBoxMm(box);
    let next = {
      xMm: normalized.xMm,
      yMm: normalized.yMm,
      widthMm: Math.max(minSizeMm, normalized.widthMm),
      heightMm: Math.max(minSizeMm, normalized.heightMm),
    };

    // Aspect-ratio lock for images.
    const doc = this.documentState();
    const targetEl = doc.elements.find((el) => el.id === drag.elementId);
    if (targetEl?.type === 'image' && targetEl.aspectRatioLocked) {
      const startAspect = drag.startBoxMm.widthMm / drag.startBoxMm.heightMm;
      const isCorner = drag.handle.length === 2;
      const isHorizontal = drag.handle === 'e' || drag.handle === 'w';
      if (isCorner || isHorizontal) {
        next = { ...next, heightMm: next.widthMm / startAspect };
      } else {
        next = { ...next, widthMm: next.heightMm * startAspect };
      }
    }

    const page = doc.page;
    let clamped = {
      xMm: Math.max(0, Math.min(page.widthMm - next.widthMm, next.xMm)),
      yMm: Math.max(0, Math.min(page.heightMm - next.heightMm, next.yMm)),
      widthMm: Math.min(page.widthMm, next.widthMm),
      heightMm: Math.min(page.heightMm, next.heightMm),
    };

    if (this.snapEnabled()) {
      clamped = snapBoxMm(clamped, this.gridSizeMm());
      clamped = {
        xMm: Math.max(0, Math.min(page.widthMm - minSizeMm, clamped.xMm)),
        yMm: Math.max(0, Math.min(page.heightMm - minSizeMm, clamped.yMm)),
        widthMm: Math.max(minSizeMm, Math.min(page.widthMm, clamped.widthMm)),
        heightMm: Math.max(minSizeMm, Math.min(page.heightMm, clamped.heightMm)),
      };
    }

    // Clamp to section bounds.
    const section = targetEl?.section ?? 'body';
    const bounds = this.sectionBoundsMm(section);
    const yMm = Math.max(bounds.topMm, Math.min(bounds.bottomMm - minSizeMm, clamped.yMm));
    const heightMm = Math.max(minSizeMm, Math.min(bounds.bottomMm - yMm, clamped.heightMm));
    clamped = { ...clamped, yMm, heightMm };

    const elements = doc.elements.map((el) => {
      if (el.id !== drag.elementId) return el;
      if (el.type !== 'table') return { ...el, ...clamped };
      const nextColumns = this.normalizeTableColumns(el.columns, clamped.widthMm);
      return { ...el, ...clamped, columns: nextColumns };
    });
    this.applyDocument({ ...doc, elements });
  }

  private applyCreate(
    drag: DragStateCreate,
    pointerMm: { readonly xMm: number; readonly yMm: number }
  ): void {
    const box = normalizeBoxMm({
      xMm: drag.startPointerMm.xMm,
      yMm: drag.startPointerMm.yMm,
      widthMm: pointerMm.xMm - drag.startPointerMm.xMm,
      heightMm: pointerMm.yMm - drag.startPointerMm.yMm,
    });

    const minSizeMm = 1;
    const doc = this.documentState();
    const page = doc.page;
    const clamped = {
      xMm: Math.max(0, Math.min(page.widthMm - minSizeMm, box.xMm)),
      yMm: Math.max(0, Math.min(page.heightMm - minSizeMm, box.yMm)),
      widthMm: Math.max(minSizeMm, Math.min(page.widthMm, box.widthMm)),
      heightMm: Math.max(minSizeMm, Math.min(page.heightMm, box.heightMm)),
    };

    let snapped = this.snapEnabled() ? snapBoxMm(clamped, this.gridSizeMm()) : clamped;

    // Clamp to section bounds.
    const targetEl = doc.elements.find((el) => el.id === drag.elementId);
    const section = targetEl?.section ?? this.activeSection();
    const bounds = this.sectionBoundsMm(section);
    const yMm = Math.max(bounds.topMm, Math.min(bounds.bottomMm - minSizeMm, snapped.yMm));
    const heightMm = Math.max(minSizeMm, Math.min(bounds.bottomMm - yMm, snapped.heightMm));
    snapped = { ...snapped, yMm, heightMm };

    const elements = doc.elements.map((el) =>
      el.id === drag.elementId ? { ...el, ...snapped } : el
    );
    this.applyDocument({ ...doc, elements });
  }

  private reorderSelected(
    reorder: (elements: readonly LaymaElement[], selectedIndex: number) => readonly LaymaElement[]
  ): void {
    const selectedId = this.primarySelectedId();
    if (!selectedId) return;
    const doc = this.documentState();
    const index = doc.elements.findIndex((el) => el.id === selectedId);
    if (index === -1) return;
    const elements = reorder(doc.elements, index);
    if (elements === doc.elements) return;
    this.applyDocument({ ...doc, elements: [...elements] });
  }
}
