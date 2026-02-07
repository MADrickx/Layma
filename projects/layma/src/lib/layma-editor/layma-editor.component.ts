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
  createDefaultLineElement,
  createDefaultImageElement,
  createDefaultRectElement,
  createDefaultTextElement,
  createEmptyDocument,
  normalizeBoxMm,
} from '../model/model';

import { LaymaPropsComponent, type LaymaPropsEvent } from '../layma-props/layma-props.component';

import { snapBoxMm, snapMm } from '../editor/snap';
import { readFileAsDataUri } from '../images/image-import';
import { exportDocumentToHtml } from '../export/export-html';
import { importRdlToLaymaDocument } from '../import/rdl/rdl-import';

type LaymaTool = 'select' | 'text' | 'rect' | 'line' | 'image';
type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

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

type DragState = DragStateNone | DragStateMove | DragStateResize | DragStateCreate;

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

  readonly document = input<LaymaDocument>(createEmptyDocument());
  readonly zoom = input<number>(1);
  readonly gridSizeMm = input<number>(5);
  readonly snapEnabled = input<boolean>(true);

  readonly documentChange = output<LaymaDocument>();
  readonly exportHtml = output<string>();

  readonly pageEl = viewChild.required<ElementRef<HTMLElement>>('page');
  readonly fileInputEl = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  readonly rdlInputEl = viewChild.required<ElementRef<HTMLInputElement>>('rdlInput');

  private readonly documentState = signal<LaymaDocument>(createEmptyDocument());

  readonly tool = signal<LaymaTool>('select');
  readonly selectedElementId = signal<LaymaElementId | null>(null);
  readonly dragState = signal<DragState>({ kind: 'none' });
  readonly pendingImageDataUri = signal<string | null>(null);
  readonly brokenImageIds = signal<ReadonlySet<LaymaElementId>>(new Set());
  readonly editingTextId = signal<LaymaElementId | null>(null);
  private replaceMode = false;

  private latestPointerEvent: PointerEvent | null = null;
  private rafId: number | null = null;
  private isDragging = false;

  readonly elements = computed(() => this.documentState().elements);
  readonly selectedElement = computed((): LaymaElement | null => {
    const selectedId = this.selectedElementId();
    if (!selectedId) return null;
    return this.documentState().elements.find((el) => el.id === selectedId) ?? null;
  });

  readonly selectionStyle = computed(() => {
    const el = this.selectedElement();
    if (!el) return null;
    return {
      left: `${el.xMm}mm`,
      top: `${el.yMm}mm`,
      width: `${el.widthMm}mm`,
      height: `${el.heightMm}mm`,
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

    // If the host replaces the document with one that doesn't contain the current selection, clear it.
    effect(() => {
      const selectedId = this.selectedElementId();
      if (!selectedId) return;
      const stillExists = this.documentState().elements.some((el) => el.id === selectedId);
      if (!stillExists) this.selectedElementId.set(null);
    });
  }

  setTool(tool: LaymaTool): void {
    this.tool.set(tool);
    if (tool === 'image' && this.pendingImageDataUri() === null) this.triggerImagePick();
  }

  selectElement(elementId: LaymaElementId): void {
    this.selectedElementId.set(elementId);
    this.tool.set('select');
  }

  clearSelection(): void {
    this.editingTextId.set(null);
    this.selectedElementId.set(null);
  }

  onTextDblClick(event: MouseEvent, elementId: LaymaElementId): void {
    event.stopPropagation();
    this.selectElement(elementId);
    this.editingTextId.set(elementId);
  }

  onTextBlur(event: FocusEvent, elementId: LaymaElementId): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const newText = target.innerText;
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

  deleteSelected(): void {
    const selectedId = this.selectedElementId();
    if (!selectedId) return;
    const nextElements = this.documentState().elements.filter((el) => el.id !== selectedId);
    this.selectedElementId.set(null);
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
    const nextDoc = importRdlToLaymaDocument(xmlText);
    this.selectedElementId.set(null);
    this.tool.set('select');
    this.applyDocument(nextDoc);
  }

  async onImageFilePicked(): Promise<void> {
    const inputEl = this.fileInputEl().nativeElement;
    const files = inputEl.files;
    inputEl.value = '';
    if (!files || files.length === 0) return;

    // Replace mode: swap the selected image's dataUri instead of creating new elements.
    if (this.replaceMode) {
      this.replaceMode = false;
      const file = files.item(0);
      if (!file) return;
      const dataUri = await readFileAsDataUri(file);
      this.replaceSelectedImageData(dataUri);
      return;
    }

    // Multi-upload: convert all files and either queue for placement or create directly.
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
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
    for (let i = 0; i < imageFiles.length; i++) {
      const dataUri = await readFileAsDataUri(imageFiles[i]);
      const offsetMm = i * 5;
      const el = createDefaultImageElement(
        { xMm: 10 + offsetMm, yMm: 10 + offsetMm, widthMm: 60, heightMm: 40 },
        dataUri
      );
      newElements.push(el);
    }
    this.applyDocument({ ...doc, elements: [...doc.elements, ...newElements] });
    if (newElements.length > 0) {
      this.selectedElementId.set(newElements[newElements.length - 1].id);
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
    const selectedId = this.selectedElementId();
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

    for (let i = 0; i < imageFiles.length; i++) {
      const dataUri = await readFileAsDataUri(imageFiles[i]);
      const offsetMm = i * 5;
      const xMm = dropMm ? dropMm.xMm + offsetMm : 10 + offsetMm;
      const yMm = dropMm ? dropMm.yMm + offsetMm : 10 + offsetMm;
      newElements.push(createDefaultImageElement({ xMm, yMm, widthMm: 60, heightMm: 40 }, dataUri));
    }

    this.applyDocument({ ...doc, elements: [...doc.elements, ...newElements] });
    if (newElements.length > 0) {
      this.selectedElementId.set(newElements[newElements.length - 1].id);
    }
    this.tool.set('select');
  }

  onPagePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const tool = this.tool();

    // If clicking on the page background while selecting, clear selection.
    if (tool === 'select') {
      this.clearSelection();
      return;
    }

    // Creation starts on page background.
    const startPointerMm = this.pointerToPageMm(event);
    if (!startPointerMm) return;

    const elementId = this.createElementForTool(tool, startPointerMm);
    if (!elementId) return;

    this.selectedElementId.set(elementId);
    this.dragState.set({ kind: 'create', tool, elementId, startPointerMm });
    this.beginGlobalPointerTracking(event);
  }

  onElementPointerDown(event: PointerEvent, elementId: LaymaElementId): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    this.selectElement(elementId);

    const pointerMm = this.pointerToPageMm(event);
    if (!pointerMm) return;

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
    const selectedId = this.selectedElementId();
    if (!selectedId) return;

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
    this.documentState.set(nextDocument);
    this.emitDocument(nextDocument);
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

    if (tool === 'image') {
      const dataUri = this.pendingImageDataUri();
      if (!dataUri) {
        this.triggerImagePick();
        return null;
      }
      const el = createDefaultImageElement({ ...seedBox, widthMm: 60, heightMm: 40 }, dataUri);
      this.applyDocument({
        ...this.documentState(),
        elements: [...this.documentState().elements, el],
      });
      return el.id;
    }

    const el =
      tool === 'text'
        ? createDefaultTextElement({ ...seedBox, widthMm: 40, heightMm: 10 })
        : tool === 'rect'
        ? createDefaultRectElement({ ...seedBox, widthMm: 40, heightMm: 25 })
        : createDefaultLineElement({ ...seedBox, widthMm: 60, heightMm: 0.6 });

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
    this.dragState.set({ kind: 'none' });

    if (drag.kind === 'create') {
      if (drag.tool === 'image') this.pendingImageDataUri.set(null);
      this.tool.set('select');
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

    const selectedId = this.selectedElementId();
    if (!selectedId) return;

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
    const selectedId = this.selectedElementId();
    if (!selectedId) return;
    const doc = this.documentState();
    const page = doc.page;

    const elements = doc.elements.map((el) => {
      if (el.id !== selectedId) return el;
      let nextX = el.xMm + dxMm;
      let nextY = el.yMm + dyMm;

      if (this.snapEnabled()) {
        const grid = this.gridSizeMm();
        nextX = snapMm(nextX, grid);
        nextY = snapMm(nextY, grid);
      }

      const maxX = Math.max(0, page.widthMm - el.widthMm);
      const maxY = Math.max(0, page.heightMm - el.heightMm);
      return {
        ...el,
        xMm: Math.max(0, Math.min(maxX, nextX)),
        yMm: Math.max(0, Math.min(maxY, nextY)),
      };
    });

    this.applyDocument({ ...doc, elements });
  }

  selectedImageObjectFit(): LaymaImageElement['objectFit'] | null {
    const el = this.selectedElement();
    return el?.type === 'image' ? el.objectFit : null;
  }

  setSelectedImageObjectFit(nextFit: LaymaImageElement['objectFit']): void {
    const selectedId = this.selectedElementId();
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

  /**
   * Generic property change handler for the properties panel.
   * Reads the value from the event target (input/select) and patches the selected element.
   */
  /** Handle property changes emitted by the LaymaPropsComponent. */
  onPropsChange(event: LaymaPropsEvent): void {
    const selectedId = this.selectedElementId();
    if (!selectedId) return;
    const doc = this.documentState();
    const elements = doc.elements.map((el) =>
      el.id === selectedId ? { ...el, [event.propName]: event.value } : el
    );
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
      const maxY = Math.max(0, page.heightMm - el.heightMm);
      return {
        ...el,
        xMm: Math.max(0, Math.min(maxX, nextX)),
        yMm: Math.max(0, Math.min(maxY, nextY)),
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

    const elements = doc.elements.map((el) =>
      el.id === drag.elementId ? { ...el, ...clamped } : el
    );
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

    const snapped = this.snapEnabled() ? snapBoxMm(clamped, this.gridSizeMm()) : clamped;

    const elements = doc.elements.map((el) =>
      el.id === drag.elementId ? { ...el, ...snapped } : el
    );
    this.applyDocument({ ...doc, elements });
  }

  private reorderSelected(
    reorder: (elements: readonly LaymaElement[], selectedIndex: number) => readonly LaymaElement[]
  ): void {
    const selectedId = this.selectedElementId();
    if (!selectedId) return;
    const doc = this.documentState();
    const index = doc.elements.findIndex((el) => el.id === selectedId);
    if (index === -1) return;
    const elements = reorder(doc.elements, index);
    if (elements === doc.elements) return;
    this.applyDocument({ ...doc, elements: [...elements] });
  }
}
