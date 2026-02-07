import { Component, signal } from '@angular/core';

import { LaymaEditorComponent, createEmptyDocument, type LaymaDocument } from 'layma';

@Component({
  selector: 'app-root',
  imports: [LaymaEditorComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly document = signal<LaymaDocument>(createEmptyDocument());
}
