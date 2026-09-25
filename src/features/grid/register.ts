import { surfaceColors } from "../../appearance";
import { useMemo } from "react";
import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDark,
  themeQuartz,
} from "ag-grid-community";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useIsDark, withAlpha } from "../../theme";

ModuleRegistry.registerModules([AllCommunityModule]);

export function useGridTheme() {
  const dark = useIsDark();
  const accent = useSettingsStore((s) => s.resolvedAccent);
  const style = useSettingsStore((s) => s.themeMode === "oled" ? "oled" : s.interfaceStyle);
  return useMemo(
    () =>
      (dark ? themeQuartz.withPart(colorSchemeDark) : themeQuartz).withParams({
        accentColor: accent,
        backgroundColor: surfaceColors(style,dark).surface,
        foregroundColor: dark ? "#e1e7ef" : "#253449",
        headerBackgroundColor: style === "oled" ? "#000000" : style === "classic" ? (dark ? "#282d35" : "#f8f9fb") : withAlpha(accent, dark ? 0.23 : 0.12),
        headerTextColor: dark ? "#e1e7ef" : "#253449",
        oddRowBackgroundColor: style === "oled" ? "#000000" : withAlpha(accent, style === "classic" ? 0.035 : dark ? 0.09 : 0.045),
        rowHoverColor: withAlpha(accent, 0.12),
        selectedRowBackgroundColor: withAlpha(accent, 0.19),
        borderColor: style === "oled" ? "#292929" : withAlpha(accent, dark ? 0.28 : 0.2),
        columnBorder: style === "studio",
        wrapperBorderRadius: style === "aurora" ? 10 : style === "studio" ? 2 : surfaceColors(style,dark).radius,
        // 紧凑模式：小字号 + 紧行高，尽量多显示内容
        fontSize: 12,
        headerFontSize: 12,
        dataFontSize: 12,
        rowHeight: 28,
        headerHeight: style === "classic" ? 38 : 46,
        cellHorizontalPadding: 8,
      }),
    [accent, dark, style],
  );
}
