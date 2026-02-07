export function snapMm(valueMm: number, gridSizeMm: number): number {
  if (!Number.isFinite(valueMm)) return valueMm;
  if (!Number.isFinite(gridSizeMm) || gridSizeMm <= 0) return valueMm;
  return Math.round(valueMm / gridSizeMm) * gridSizeMm;
}

export function snapBoxMm(
  box: {
    readonly xMm: number;
    readonly yMm: number;
    readonly widthMm: number;
    readonly heightMm: number;
  },
  gridSizeMm: number
): { xMm: number; yMm: number; widthMm: number; heightMm: number } {
  return {
    xMm: snapMm(box.xMm, gridSizeMm),
    yMm: snapMm(box.yMm, gridSizeMm),
    widthMm: snapMm(box.widthMm, gridSizeMm),
    heightMm: snapMm(box.heightMm, gridSizeMm),
  };
}
