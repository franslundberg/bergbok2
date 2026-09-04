export const DEFAULT_WORKBENCH_WIDTH = 384;
export const MIN_WORKBENCH_WIDTH = 200;
export const MAX_WORKBENCH_WIDTH = 1600;

export const maximumWorkbenchWidth = (viewportWidth: number) =>
  Math.max(MIN_WORKBENCH_WIDTH, Math.min(MAX_WORKBENCH_WIDTH, Math.floor(viewportWidth - 64)));

export const clampWorkbenchWidth = (width: number, viewportWidth: number) =>
  Math.min(Math.max(Math.round(width), MIN_WORKBENCH_WIDTH), maximumWorkbenchWidth(viewportWidth));
