# Layma Documentation

## Overview

Layma is a WYSIWYG (What You See Is What You Get) layout editor for creating invoice and quote templates. It's built as an Angular standalone component library that generates self-contained HTML files with CSS in the header, making it easy to convert to PDFs or perform text replacements.

### Key Features

- **Element Types**: Text boxes, rectangles, lines, images, and tables
- **Interactive Editing**: Drag-and-drop, resize handles, inline text editing
- **Grid Snapping**: Optional grid-based positioning for precise alignment
- **Z-Order Management**: Layer ordering (bring forward, send backward, etc.)
- **RDL Import**: Convert Microsoft Report Builder (`.rdl`) files to Layma format
- **HTML Export**: Self-contained HTML with base64-encoded images
- **Properties Panel**: Sticky sidebar for editing element properties

---

## Architecture

### Project Structure

```
Layma/
├── projects/layma/          # Library package
│   └── src/lib/
│       ├── model/           # Data structures
│       ├── layma-editor/    # Main editor component
│       ├── layma-props/     # Properties panel component
│       ├── editor/          # Editor utilities (snap)
│       ├── export/          # HTML export logic
│       ├── import/rdl/      # RDL import converter
│       └── images/          # Image handling utilities
└── src/app/                 # Demo application
```

### Technology Stack

- **Angular 21**: Standalone components, signals, OnPush change detection
- **TypeScript**: Strict typing (no `any` types)
- **Vanilla CSS**: No CSS frameworks
- **Pointer Events API**: For drag-and-drop interactions
- **DOMParser**: For RDL XML parsing

---

## Data Model

### Core Types

#### `LaymaDocument`

The root document structure:

```typescript
interface LaymaDocument {
  readonly page: LaymaPage;
  readonly elements: readonly LaymaElement[];
}
```

#### `LaymaPage`

Page dimensions in millimeters (for PDF compatibility):

```typescript
interface LaymaPage {
  readonly widthMm: number;   // A4 portrait: 210
  readonly heightMm: number; // A4 portrait: 297
}
```

#### `LaymaElement`

A discriminated union of all element types. All elements share a common base:

```typescript
interface LaymaElementBase {
  readonly id: LaymaElementId;  // Unique identifier (UUID or timestamp-based)
  readonly type: LaymaElementType;
  readonly xMm: number;          // Top-left X position in mm
  readonly yMm: number;          // Top-left Y position in mm
  readonly widthMm: number;     // Width in mm
  readonly heightMm: number;    // Height in mm
}
```

### Element Types

#### 1. Text Element (`LaymaTextElement`)

```typescript
interface LaymaTextElement extends LaymaElementBase {
  readonly type: 'text';
  readonly text: string;              // Content (supports RDL tags like #Dataset_Field#)
  readonly fontFamily: string;        // CSS font-family
  readonly fontSizePt: number;       // Font size in points
  readonly color: string;             // CSS color
  readonly align: 'left' | 'center' | 'right';
}
```

**Features:**
- Double-click to edit inline
- Text wraps within bounds
- Supports RDL placeholder tags (e.g., `#InvoiceHeader_DocumentNumber#`)

#### 2. Rectangle Element (`LaymaRectElement`)

```typescript
interface LaymaRectElement extends LaymaElementBase {
  readonly type: 'rect';
  readonly fillColor: string;         // CSS color (can be 'transparent')
  readonly borderColor: string;       // CSS color
  readonly borderWidthMm: number;     // Border thickness in mm
  readonly borderRadiusMm: number;  // Corner radius in mm
}
```

#### 3. Line Element (`LaymaLineElement`)

```typescript
interface LaymaLineElement extends LaymaElementBase {
  readonly type: 'line';
  readonly color: string;             // CSS color (used as background)
}
```

**Note:** Lines have a minimum thickness of 0.3mm for visibility.

#### 4. Image Element (`LaymaImageElement`)

```typescript
interface LaymaImageElement extends LaymaElementBase {
  readonly type: 'image';
  readonly dataUri: string;           // Base64 data URI: data:image/png;base64,...
  readonly objectFit: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity: number;           // 0-1
  readonly borderRadiusMm: number;   // Corner radius
  readonly aspectRatioLocked: boolean; // Lock aspect ratio during resize
}
```

**Features:**
- Drag-and-drop multiple images
- Replace existing images
- Broken image placeholder (SVG icon)
- Aspect ratio locking during resize

#### 5. Table Element (`LaymaTableElement`)

```typescript
interface LaymaTableElement extends LaymaElementBase {
  readonly type: 'table';
  readonly columns: readonly LaymaTableColumn[];
  readonly header: readonly LaymaTableCell[];
  readonly rowTemplate: readonly LaymaTableCell[];
  readonly borderColor: string;
  readonly borderWidthMm: number;
  readonly headerBackground: string;
}

interface LaymaTableColumn {
  readonly widthMm: number;
  readonly align: 'left' | 'center' | 'right';
}

interface LaymaTableCell {
  readonly text: string;
  readonly isHeader: boolean;
}
```

**Features:**
- Imported from RDL `Tablix` elements
- Header row with distinct styling
- Row template for data binding
- Column width control

### Utility Functions

#### `createLaymaElementId()`

Generates unique IDs using `crypto.randomUUID()` if available, otherwise falls back to timestamp-based IDs.

#### `normalizeBoxMm(box)`

Normalizes a box to ensure positive width/height and corrects x/y if width/height are negative (handles drag-from-any-corner).

#### `clampMm(value, min, max)`

Clamps a value between min and max.

---

## Core Components

### 1. LaymaEditorComponent

**Location:** `projects/layma/src/lib/layma-editor/layma-editor.component.ts`

The main editor component that orchestrates all interactions.

#### Inputs

- `document: LaymaDocument` - The document model (defaults to empty A4)
- `zoom: number` - CSS scale factor (default: 1)
- `gridSizeMm: number` - Grid cell size in mm (default: 5)
- `snapEnabled: boolean` - Enable grid snapping (default: true)

#### Outputs

- `documentChange: LaymaDocument` - Emitted on any document change
- `exportHtml: string` - Emitted when exporting (contains HTML string)

#### Internal State (Signals)

```typescript
documentState: Signal<LaymaDocument>      // Internal document copy
tool: Signal<LaymaTool>                   // Current tool: 'select' | 'text' | 'rect' | 'line' | 'image'
selectedElementId: Signal<string | null>  // Selected element ID
dragState: Signal<DragState>              // Current drag operation
pendingImageDataUri: Signal<string | null> // Image queued for placement
brokenImageIds: Signal<Set<string>>       // Track broken images
editingTextId: Signal<string | null>      // Text element being edited inline
```

#### Drag States

The editor uses a discriminated union for drag operations:

```typescript
type DragState =
  | { kind: 'none' }
  | { kind: 'move'; elementId: string; startPointerMm: {...}; startElementMm: {...} }
  | { kind: 'resize'; elementId: string; handle: ResizeHandle; startPointerMm: {...}; startBoxMm: {...} }
  | { kind: 'create'; tool: LaymaTool; elementId: string; startPointerMm: {...} }
```

#### Key Methods

**Pointer Event Handling:**

- `onPagePointerDown(event)` - Handles clicks on page background (creation or deselection)
- `onElementPointerDown(event, elementId)` - Handles clicks on elements (selection + move start)
- `onResizeHandlePointerDown(event, handle)` - Handles resize handle clicks

**Global Pointer Tracking:**

- `beginGlobalPointerTracking(event)` - Sets up window-level listeners for drag operations
- `onGlobalPointerMove` - Throttled via `requestAnimationFrame` for smooth dragging
- `onGlobalPointerUp` - Finalizes drag and cleans up listeners

**Coordinate Conversion:**

- `clientToPageMm(clientX, clientY)` - Converts screen coordinates to page-relative mm
- `pointerToPageMm(event)` - Wrapper for pointer events

**Element Creation:**

- `createElementForTool(tool, startPointerMm)` - Creates a new element based on the active tool
- For images, checks `pendingImageDataUri` and triggers file picker if needed

**Drag Operations:**

- `applyMove(drag, pointerMm)` - Moves an element, applies snapping, clamps to page bounds
- `applyResize(drag, pointerMm)` - Resizes an element, handles aspect ratio locking for images
- `applyCreate(drag, pointerMm)` - Updates element size during creation drag

**Z-Order:**

- `bringForward()` - Swaps with next element
- `sendBackward()` - Swaps with previous element
- `bringToFront()` - Moves to end of array
- `sendToBack()` - Moves to beginning of array

**Keyboard Navigation:**

- `onGlobalKeyDown(event)` - Arrow keys to nudge selected element
- Shift+Arrow = 5x step size
- Respects snap-to-grid if enabled

**Image Handling:**

- `triggerImagePick()` - Opens file picker
- `onImageFilePicked()` - Handles single or multi-file upload
- `replaceSelectedImage()` - Replaces selected image's data URI
- `onImageError(elementId)` - Marks image as broken
- `onStageDrop(event)` - Handles drag-and-drop images onto canvas

**RDL Import:**

- `triggerRdlPick()` - Opens RDL file picker
- `onRdlFilePicked()` - Parses RDL XML and imports elements

**Text Editing:**

- `onTextDblClick(event, elementId)` - Enters inline edit mode
- `onTextBlur(event, elementId)` - Commits text changes
- `onTextKeyDown(event)` - Prevents global shortcuts while typing

**Export:**

- `exportHtmlString()` - Generates self-contained HTML
- `downloadHtml(filename)` - Triggers browser download

#### Template Structure

The template (`layma-editor.component.html`) uses CSS Grid:

```
┌─────────┬─────────────────────────────────────┐
│ Sidebar │ Header (actions)                    │
│ (tools) ├─────────────────────────────────────┤
│         │                                     │
│         │ Stage (canvas + properties panel)   │
│         │                                     │
└─────────┴─────────────────────────────────────┘
```

**Sidebar:** Tool buttons with SVG icons
**Header:** Export HTML, Import RDL buttons
**Stage:** Scrollable container with:
  - Page element (A4 canvas with grid background)
  - Element hosts (absolute positioned)
  - Selection handles (8 resize handles)
  - Properties panel (sticky, right side)

#### Rendering Elements

Elements are rendered using `@switch` on `el.type`:

- **Text:** `<div contenteditable>` with dynamic styles
- **Rect:** `<div>` with background/border styles
- **Line:** `<div>` with background color
- **Image:** `<img>` or placeholder SVG if broken
- **Table:** `<table>` with colgroup, thead, tbody

Each element host has:
- `position: absolute` with mm-based positioning
- Dashed outline (editor-only, not exported)
- Hover state (blue outline)
- Selected state (removes outline, shows handles)

#### Selection Handles

8 handles positioned at corners and edges:
- `nw`, `n`, `ne`, `e`, `se`, `s`, `sw`, `w`
- Each handle triggers `onResizeHandlePointerDown` with the handle direction

---

### 2. LaymaPropsComponent

**Location:** `projects/layma/src/lib/layma-props/layma-props.component.ts`

A standalone component for editing element properties. Uses sticky positioning to remain visible during scrolling.

#### Inputs

- `element: LaymaElement` (required) - The element to edit

#### Outputs

- `propChange: LaymaPropsEvent` - Emitted on property changes
- `close: void` - Emitted when close button clicked
- `deleteElement: void` - Emitted when delete button clicked
- `reorder: 'forward' | 'backward' | 'front' | 'back'` - Emitted for z-order changes
- `replaceImage: void` - Emitted to replace image
- `imageFitChange: LaymaImageElement['objectFit']` - Emitted for object-fit changes

#### Type Narrowing

Angular's template compiler doesn't narrow discriminated unions well, so the component uses computed signals:

```typescript
asText = computed((): LaymaTextElement | null => {
  const el = this.element();
  return el.type === 'text' ? el : null;
});
```

The template uses `@if (asText(); as t)` to safely access text-specific properties.

#### Property Sections

1. **Position & Size:** X, Y, Width, Height inputs
2. **Layer:** Z-order buttons (back, backward, forward, front)
3. **Text:** Font family, size, color, alignment (if text element)
4. **Style:** Fill, border, border width, radius (if rect element)
5. **Style:** Color (if line element)
6. **Image:** Object-fit, opacity slider, border radius, aspect ratio lock, replace button (if image element)
7. **Table:** Border color (if table element)
8. **Delete:** Delete button (always visible)

#### Event Handling

- `onPropChange(propName, event)` - Parses input/select values, emits `LaymaPropsEvent`
- `onPropCheckboxChange(propName, event)` - Handles checkbox toggles
- `onImageFitChange(event)` - Handles object-fit selector

---

## Export System

**Location:** `projects/layma/src/lib/export/export-html.ts`

### `exportDocumentToHtml(doc: LaymaDocument): string`

Generates a self-contained HTML file with:
- CSS in `<style>` tag in `<head>`
- Base64-encoded images inline
- All elements absolutely positioned in mm units
- Page container with A4 dimensions

### HTML Structure

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    /* Global resets, page container, table styles */
  </style>
</head>
<body>
  <div class="page">
    <!-- Elements as absolutely positioned divs/img -->
  </div>
</body>
</html>
```

### Element Export

Each element type is converted to HTML:

- **Text:** `<div class="layma-text">` with inline styles
- **Rect:** `<div class="layma-rect">` with background/border styles
- **Line:** `<div class="layma-line">` with background color
- **Image:** `<img class="layma-image">` with data URI src
- **Table:** `<div class="layma-table"><table>...</table></div>` with colgroup and cells

### CSS Generation

The exported CSS includes:
- Global resets (`html, body { margin: 0; padding: 0 }`)
- Page container (mm-based dimensions)
- Table styles (border-collapse, cell padding, header background)

### HTML Escaping

- `escapeHtmlText(text)` - Escapes `&`, `<`, `>` for text content
- `escapeHtmlAttr(value)` - Escapes `&`, `"`, `<`, `>` for attributes

---

## Import System (RDL)

**Location:** `projects/layma/src/lib/import/rdl/rdl-import.ts`

### `importRdlToLaymaDocument(xmlText: string): LaymaDocument`

Converts Microsoft Report Builder (`.rdl`) XML files to Layma documents.

### RDL Structure

RDL files contain:
- `<Report>` root
- `<PageWidth>`, `<PageHeight>`, margins
- `<ReportSection>` with `<PageHeader>`, `<Body>`, `<PageFooter>`
- Each section has `<ReportItems>` containing:
  - `<Textbox>` - Text elements
  - `<Image>` - Image elements
  - `<Line>` - Line elements
  - `<Tablix>` - Table elements

### Unit Conversion

`mmFromRdlSize(value)` converts RDL size strings to millimeters:
- `cm` → `mm * 10`
- `in` → `mm * 25.4`
- `pt` → `mm * 25.4 / 72`
- `mm` → unchanged

### Element Import Functions

#### `importTextbox(textboxEl, offsetMm, datasetHint)`

Extracts:
- Position (`Left`, `Top`, `Width`, `Height`)
- Text value (parsed via `textFromRdlValue`)
- Font (`FontFamily`, `FontSize`, `Color`, `TextAlign`)

#### `importLine(lineEl, offsetMm)`

Extracts position and color. Ensures minimum thickness of 0.3mm.

#### `importImage(imgEl, offsetMm, embedded, datasetHint)`

Handles two image sources:
1. **Embedded:** Resolves from `<EmbeddedImage>` map using parameter name
2. **External:** Creates SVG placeholder with label

Extracts `Sizing` to determine `objectFit`:
- `FitProportional` → `contain`
- `Fit` → `fill`
- Default → `contain`

#### `importTablixAsTable(tablixEl, offsetMm, datasetHint)`

Converts RDL `Tablix` to `LaymaTableElement`:
1. Extracts columns from `<TablixColumn>` elements
2. Extracts header row (first `<TablixRow>`)
3. Extracts detail row template (second `<TablixRow>`)
4. Normalizes column count to match cells

### Text Expression Parsing

`textFromRdlValue(rdlValue, datasetHint)` parses RDL expressions:

**Pattern:** `=First(Fields!FieldName.Value, "Dataset")` or `=Parameters!ParamName.Value`

**Output Format:**
- Fields: `#Dataset_FieldName#` (e.g., `#InvoiceHeader_DocumentNumber#`)
- Parameters: `ParameterName` (no hash wrappers, e.g., `Vat6`)
- Globals: `#Globals_GlobalName#`

**Strategy:**
1. Scans entire expression for `Fields!`, `Parameters!`, `Globals!` references
2. Resolves dataset name from `First(..., "Dataset")` wrapper or `datasetHint`
3. Joins tokens with spaces (concatenations become spaces)
4. Falls back to static strings or raw expression if no matches

### Embedded Images

`buildEmbeddedImagesMap(doc)` extracts `<EmbeddedImage>` elements:
- Maps `Name` → `data:image/png;base64,...` data URI

`resolveEmbeddedImageDataUri(valueExpression, embedded)` resolves image references:
- Handles parameter references (e.g., `=Parameters!phone241.Value`)
- Heuristic: if parameter ends with `1`, tries without the `1` (e.g., `phone241` → `phone24`)

### Section Offsets

Elements are positioned relative to section offsets:
- **PageHeader:** `{ xMm: leftMargin, yMm: topMargin }`
- **Body:** `{ xMm: leftMargin, yMm: topMargin + headerHeight }`
- **PageFooter:** `{ xMm: leftMargin, yMm: pageHeight - bottomMargin - footerHeight }`

### Dataset Hints

Each section uses a dataset hint for field resolution:
- PageHeader → `'InvoiceHeader'`
- Body → `'InvoiceLine'`
- PageFooter → `'InvoiceFooter'`

---

## Utilities

### Snap Functions

**Location:** `projects/layma/src/lib/editor/snap.ts`

#### `snapMm(valueMm, gridSizeMm): number`

Snaps a single value to the nearest grid multiple:
```typescript
Math.round(valueMm / gridSizeMm) * gridSizeMm
```

#### `snapBoxMm(box, gridSizeMm)`

Snaps all four box coordinates (x, y, width, height) to the grid.

**Usage:** Applied during drag, resize, create, and arrow key nudging when `snapEnabled` is true.

### Image Import

**Location:** `projects/layma/src/lib/images/image-import.ts`

#### `readFileAsDataUri(file): Promise<string>`

Converts a `File` object to a base64 data URI using `FileReader.readAsDataURL()`.

**Usage:** Called when picking images or dropping files onto the canvas.

---

## Demo Application

**Location:** `src/app/`

A minimal Angular application that demonstrates the editor:

```typescript
@Component({
  selector: 'app-root',
  imports: [LaymaEditorComponent],
  templateUrl: './app.html',
})
export class App {
  readonly document = signal<LaymaDocument>(createEmptyDocument());
}
```

**Template:**
```html
<layma-editor
  [document]="document()"
  (documentChange)="document.set($event)"
  [zoom]="1"
  [gridSizeMm]="5"
  [snapEnabled]="true"
/>
```

The demo uses two-way binding to keep the document signal in sync with editor changes.

---

## Styling

### CSS Architecture

- **No CSS frameworks** - Pure vanilla CSS
- **BEM-like naming** - `.layma-component`, `.layma-component--modifier`
- **CSS Grid** - Used for main editor layout
- **CSS Variables** - `--layma-grid-size` for dynamic grid background
- **Sticky Positioning** - Properties panel uses `position: sticky`

### Key Styles

#### Editor Grid Layout

```css
.layma-editor {
  display: grid;
  grid-template-columns: 48px 1fr;  /* Sidebar | Content */
  grid-template-rows: 48px 1fr;       /* Header | Stage */
}
```

#### Page Grid Background

```css
.layma-page {
  background-image:
    linear-gradient(to right, rgba(17, 24, 39, 0.04) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(17, 24, 39, 0.04) 1px, transparent 1px);
  background-size: var(--layma-grid-size, 5mm) var(--layma-grid-size, 5mm);
}
```

#### Element Wireframes

```css
.layma-elementHost {
  outline: 1px dashed rgba(148, 163, 184, 0.45);  /* Editor-only */
}
```

The outline is only visible in the editor, not in exported HTML.

---

## Performance Considerations

### Change Detection

- **OnPush Strategy:** Both `LaymaEditorComponent` and `LaymaPropsComponent` use `ChangeDetectionStrategy.OnPush`
- **Signals:** State is managed with Angular signals for efficient reactivity
- **Computed Signals:** Derived values (like `selectedElement`) are computed signals

### Pointer Event Throttling

- **requestAnimationFrame:** Drag operations are throttled via `rafId` to prevent excessive updates
- **runOutsideAngular:** Not explicitly used, but pointer events are handled outside Angular's zone via native listeners

### Rendering Optimization

- **Track By ID:** `@for` loops use `track el.id` for efficient list updates
- **Conditional Rendering:** Properties panel only renders when an element is selected

---

## Extension Points

### Adding New Element Types

1. **Update Model** (`model.ts`):
   - Add type to `LaymaElementType` union
   - Create interface extending `LaymaElementBase`
   - Add to `LaymaElement` union
   - Create `createDefaultXxxElement()` function

2. **Update Editor Component**:
   - Add tool button in template (if needed)
   - Add `@case` in element rendering switch
   - Handle creation in `createElementForTool()`
   - Add export logic in `export-html.ts`

3. **Update Properties Component**:
   - Add computed signal for type narrowing
   - Add property section in template

### Adding New Import Formats

Create a new file in `import/` directory:
- Parse input format
- Convert to `LaymaDocument`
- Add import button/functionality in editor

### Customizing Export

Modify `export-html.ts`:
- Change HTML structure
- Add custom CSS
- Transform element data before export

---

## Best Practices

### Immutability

All document updates create new objects:
```typescript
const elements = doc.elements.map(el =>
  el.id === selectedId ? { ...el, xMm: newX } : el
);
```

### Type Safety

- No `any` types
- Discriminated unions for element types
- Computed signals for type narrowing in templates

### Code Organization

- Single responsibility per file
- Pure functions where possible
- Clear naming conventions
- Minimal dependencies

---

## Known Limitations

1. **Single Page:** Only supports single-page documents (no multi-page)
2. **No Undo/Redo:** History management not implemented
3. **No Groups:** Elements cannot be grouped together
4. **Limited Table Editing:** Tables imported from RDL, limited manual editing
5. **No Rotation:** Elements cannot be rotated
6. **No Copy/Paste:** No clipboard operations
7. **RDL Coverage:** Not all RDL features are supported (e.g., subreports, charts)

---

## Future Enhancements

Potential additions:
- Multi-page support
- Undo/redo system
- Element grouping
- Rotation handles
- Copy/paste
- More RDL import features
- Export to PDF directly (via browser print or library)
- Template library
- Collaborative editing

---

## Conclusion

Layma is a focused, performant WYSIWYG editor built with modern Angular practices. Its architecture prioritizes readability, type safety, and extensibility while remaining an MVP suitable for invoice/quote layout creation.
