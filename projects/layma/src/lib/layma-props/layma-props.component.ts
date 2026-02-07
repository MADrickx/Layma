import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type {
  LaymaElement,
  LaymaImageElement,
  LaymaLineElement,
  LaymaRectElement,
  LaymaTableElement,
  LaymaTextElement,
} from '../model/model';

export interface LaymaPropsEvent {
  readonly propName: string;
  readonly value: string | number | boolean;
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
}
