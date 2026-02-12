import { Component, signal } from '@angular/core';

import {
  LaymaEditorComponent,
  LaymaTableEntityBinding,
  createEmptyDocument,
  type LaymaDocument,
} from 'layma';

@Component({
  selector: 'app-root',
  imports: [LaymaEditorComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly document = signal<LaymaDocument>(createEmptyDocument());
  readonly bindings = [
    { mainEntity: 'InvoiceHeader', repeatableEntity: ['InvoiceLine'] },
    { mainEntity: 'Order', repeatableEntity: ['OrderLine', 'ShipmentLine'] },
  ] as readonly LaymaTableEntityBinding[];
}
