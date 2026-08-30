import { createContext, useContext } from "react";
import { uiScaleFor, type UiScale } from "./settings.ts";
import { DEFAULT_FONT_SIZE } from "./tui-config.ts";

export const DensityContext = createContext<UiScale>(uiScaleFor(DEFAULT_FONT_SIZE));

export function useDensity(): UiScale {
  return useContext(DensityContext);
}
