import type { LayoutInput, LayoutResult } from './types';

export const TOP_BAR_HEIGHT = 40;
export const RAIL_WIDTH = 216;
export const VIEWPORT_HEADER_HEIGHT = 28;
export const DIVIDER_WIDTH = 6;
export const TELEMETRY_BAR_HEIGHT = 28;
export const DEVTOOLS_HEADER_HEIGHT = 28;
export const MIN_DOCK_HEIGHT = 140;
export const MAX_DOCK_RATIO = 0.65;
export const MIN_SPLIT_RATIO = 0.22;
export const MAX_SPLIT_RATIO = 0.68;
export const MIN_VIEWPORT_HEIGHT = 120;
export const MIN_VIEWPORT_WIDTH = 180;

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computeFitScale(
  containerWidth: number,
  containerHeight: number,
  targetWidth: number,
  targetHeight: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return 1;
  }
  const scaleX = containerWidth / targetWidth;
  const scaleY = containerHeight / targetHeight;
  return clamp(Math.min(scaleX, scaleY, 1), 0.25, 1);
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const winW = Math.max(320, Math.floor(input.windowWidth));
  const winH = Math.max(320, Math.floor(input.windowHeight));

  const railWidth = input.railCollapsed ? 0 : Math.min(RAIL_WIDTH, Math.floor(winW * 0.28));
  const topBar = { x: 0, y: 0, width: winW, height: TOP_BAR_HEIGHT };
  const rail = railWidth > 0 ? { x: 0, y: TOP_BAR_HEIGHT, width: railWidth, height: winH - TOP_BAR_HEIGHT } : null;

  const contentX = railWidth;
  const contentW = Math.max(MIN_VIEWPORT_WIDTH, winW - railWidth);
  const availableH = Math.max(MIN_VIEWPORT_HEIGHT + TELEMETRY_BAR_HEIGHT, winH - TOP_BAR_HEIGHT);

  const maxDockH = Math.max(
    MIN_DOCK_HEIGHT,
    Math.min(
      Math.floor(availableH * MAX_DOCK_RATIO),
      availableH - VIEWPORT_HEADER_HEIGHT - MIN_VIEWPORT_HEIGHT,
    ),
  );

  const clampedDockHeight = input.dockOpen
    ? clamp(Math.floor(input.dockHeight), MIN_DOCK_HEIGHT, maxDockH)
    : TELEMETRY_BAR_HEIGHT;

  const dockTotalH = input.dockOpen ? clampedDockHeight : TELEMETRY_BAR_HEIGHT;
  const dockY = winH - dockTotalH;
  const stageH = Math.max(VIEWPORT_HEADER_HEIGHT + 60, dockY - TOP_BAR_HEIGHT);
  const viewY = TOP_BAR_HEIGHT + VIEWPORT_HEADER_HEIGHT;
  const viewH = Math.max(60, stageH - VIEWPORT_HEADER_HEIGHT);

  const telemetryBar = {
    x: contentX,
    y: dockY,
    width: contentW,
    height: TELEMETRY_BAR_HEIGHT,
  };

  const devtoolsHeader = input.dockOpen
    ? {
        x: contentX,
        y: dockY + TELEMETRY_BAR_HEIGHT,
        width: contentW,
        height: DEVTOOLS_HEADER_HEIGHT,
      }
    : null;

  const devtoolsViewH = Math.max(0, dockTotalH - TELEMETRY_BAR_HEIGHT - DEVTOOLS_HEADER_HEIGHT);
  const devtoolsView =
    input.dockOpen && devtoolsViewH > 0
      ? {
          x: contentX,
          y: dockY + TELEMETRY_BAR_HEIGHT + DEVTOOLS_HEADER_HEIGHT,
          width: contentW,
          height: devtoolsViewH,
        }
      : null;

  const clampedSplitRatio = clamp(input.splitRatio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);

  if (input.mode === 'single') {
    return {
      topBar,
      rail,
      portraitHeader: null,
      portraitView: null,
      divider: null,
      landscapeHeader: {
        x: contentX,
        y: TOP_BAR_HEIGHT,
        width: contentW,
        height: VIEWPORT_HEADER_HEIGHT,
      },
      landscapeView: {
        x: contentX,
        y: viewY,
        width: contentW,
        height: viewH,
      },
      telemetryBar,
      devtoolsHeader,
      devtoolsView,
      clampedSplitRatio,
      clampedDockHeight,
    };
  }

  const usableSplitW = Math.max(200, contentW - DIVIDER_WIDTH);
  const minPaneW = Math.min(MIN_VIEWPORT_WIDTH, Math.floor(usableSplitW * 0.35));
  const portraitW = clamp(
    Math.floor(usableSplitW * clampedSplitRatio),
    minPaneW,
    usableSplitW - minPaneW,
  );
  const dividerX = contentX + portraitW;
  const landscapeX = dividerX + DIVIDER_WIDTH;
  const landscapeW = Math.max(minPaneW, contentX + contentW - landscapeX);

  return {
    topBar,
    rail,
    portraitHeader: {
      x: contentX,
      y: TOP_BAR_HEIGHT,
      width: portraitW,
      height: VIEWPORT_HEADER_HEIGHT,
    },
    portraitView: {
      x: contentX,
      y: viewY,
      width: portraitW,
      height: viewH,
    },
    divider: {
      x: dividerX,
      y: TOP_BAR_HEIGHT,
      width: DIVIDER_WIDTH,
      height: stageH,
    },
    landscapeHeader: {
      x: landscapeX,
      y: TOP_BAR_HEIGHT,
      width: landscapeW,
      height: VIEWPORT_HEADER_HEIGHT,
    },
    landscapeView: {
      x: landscapeX,
      y: viewY,
      width: landscapeW,
      height: viewH,
    },
    telemetryBar,
    devtoolsHeader,
    devtoolsView,
    clampedSplitRatio,
    clampedDockHeight,
  };
}
