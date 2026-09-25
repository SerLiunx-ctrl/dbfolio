import {useMotionPreference} from "./useMotionPreference";
import { SURFACE_PALETTES, surfaceColors, mixColor } from "./appearance";
import { useEffect, useMemo, useState } from "react";
import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { useSettingsStore } from "./stores/useSettingsStore";

/* ---------- 颜色工具 ---------- */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "").trim();
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
  const number = Number.parseInt(full, 16);
  if (!Number.isFinite(number)) return { r: 15, g: 108, b: 189 };
  return {
    r: (number >> 16) & 0xff,
    g: (number >> 8) & 0xff,
    b: number & 0xff,
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value + m)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 由单一强调色生成 Fluent 16 级品牌色阶 */
export function brandVariantsFromHex(hex: string): BrandVariants {
  const { h, s } = hexToHsl(hex);
  const lightness = [8, 14, 20, 26, 31, 36, 41, 46, 51, 56, 62, 68, 75, 82, 89, 95];
  const variants: Record<number, string> = {};
  lightness.forEach((l, index) => {
    const key = 10 + index * 10;
    const saturation = Math.min(
      0.95,
      Math.max(0.22, s * (1 - Math.abs(52 - l) / 120)),
    );
    variants[key] = hslToHex(h, saturation, l / 100);
  });
  return variants as unknown as BrandVariants;
}

/* ---------- 主题 ---------- */

const lightOverrides: Partial<Theme> = {
  colorNeutralBackground1: "rgba(255, 255, 255, 0.65)",
  colorNeutralBackground2: "rgba(255, 255, 255, 0.45)",
  colorNeutralBackground3: "rgba(255, 255, 255, 0.3)",
  colorNeutralBackground4: "rgba(255, 255, 255, 0.6)",
  colorNeutralBackground5: "rgba(255, 255, 255, 0.75)",
  colorNeutralBackground6: "rgba(255, 255, 255, 0.85)",
  colorNeutralBackground1Hover: "rgba(255, 255, 255, 0.85)",
  colorNeutralBackground1Pressed: "rgba(255, 255, 255, 0.95)",
  colorNeutralBackground1Selected: "rgba(255, 255, 255, 0.8)",
  colorNeutralBackground2Hover: "rgba(255, 255, 255, 0.65)",
  colorNeutralBackground2Pressed: "rgba(255, 255, 255, 0.75)",
  colorNeutralBackground2Selected: "rgba(255, 255, 255, 0.6)",
  colorNeutralBackground3Hover: "rgba(255, 255, 255, 0.5)",
  colorNeutralBackground3Pressed: "rgba(255, 255, 255, 0.6)",
  colorNeutralBackground3Selected: "rgba(255, 255, 255, 0.45)",
  colorSubtleBackground: "transparent",
  colorSubtleBackgroundHover: "rgba(0, 0, 0, 0.05)",
  colorSubtleBackgroundSelected: "rgba(0, 0, 0, 0.07)",
};

const darkOverrides: Partial<Theme> = {
  colorNeutralBackground1: "rgba(44, 44, 44, 0.78)",
  colorNeutralBackground2: "rgba(40, 40, 40, 0.62)",
  colorNeutralBackground3: "rgba(36, 36, 36, 0.5)",
  colorNeutralBackground4: "rgba(48, 48, 48, 0.72)",
  colorNeutralBackground5: "rgba(52, 52, 52, 0.82)",
  colorNeutralBackground6: "rgba(56, 56, 56, 0.9)",
  colorNeutralBackground1Hover: "rgba(58, 58, 58, 0.85)",
  colorNeutralBackground1Pressed: "rgba(66, 66, 66, 0.9)",
  colorNeutralBackground1Selected: "rgba(62, 62, 62, 0.8)",
  colorNeutralBackground2Hover: "rgba(52, 52, 52, 0.7)",
  colorNeutralBackground2Pressed: "rgba(58, 58, 58, 0.78)",
  colorNeutralBackground2Selected: "rgba(54, 54, 54, 0.68)",
  colorNeutralBackground3Hover: "rgba(48, 48, 48, 0.6)",
  colorNeutralBackground3Pressed: "rgba(52, 52, 52, 0.68)",
  colorNeutralBackground3Selected: "rgba(50, 50, 50, 0.58)",
  colorSubtleBackground: "transparent",
  colorSubtleBackgroundHover: "rgba(255, 255, 255, 0.08)",
  colorSubtleBackgroundSelected: "rgba(255, 255, 255, 0.12)",
};

export function buildTheme(dark: boolean, accent: string, style = "aurora", density = "compact"): Theme {
  const brand = brandVariantsFromHex(accent);
  const base = {...(dark ? createDarkTheme(brand) : createLightTheme(brand)), ...(density === "compact" ? {
    fontFamilyBase: '"Inter", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    fontSizeBase300: "13px", lineHeightBase300: "18px",
    fontSizeBase400: "15px", lineHeightBase400: "22px",
    fontSizeBase500: "18px", lineHeightBase500: "24px",
    borderRadiusMedium: "5px", borderRadiusLarge: "8px",
  } : {})};
  if (style === "oled") return {...base,
    colorNeutralBackground1:'#000000',colorNeutralBackground2:'#000000',colorNeutralBackground3:'#000000',
    colorNeutralBackground4:'#000000',colorNeutralBackground5:'#000000',colorNeutralBackground6:'#000000',
    colorNeutralBackgroundStatic:'#000000',colorNeutralBackgroundAlpha:'#000000',
    colorNeutralBackground1Hover:'#101010',colorNeutralBackground2Hover:'#101010',colorNeutralBackground3Hover:'#101010',
    colorNeutralBackground1Pressed:'#202020',colorNeutralBackground2Pressed:'#202020',colorNeutralBackground3Pressed:'#202020',
    colorNeutralBackground1Selected:'#181818',colorNeutralBackground2Selected:'#181818',colorNeutralBackground3Selected:'#181818',
    colorSubtleBackgroundHover:'#101010',colorSubtleBackgroundPressed:'#202020',colorSubtleBackgroundSelected:'#181818',
    colorNeutralStroke1:'#383838',colorNeutralStroke2:'#292929',colorNeutralStroke3:'#202020',
  };
  if (!SURFACE_PALETTES[style]) return { ...base, ...(dark ? darkOverrides : lightOverrides) };
  const p=surfaceColors(style,dark), hover=mixColor(p.surface,accent,dark?.18:.09), selected=mixColor(p.surface,accent,dark?.27:.16);
  return {...base, colorNeutralBackground1:p.surface,colorNeutralBackground2:p.background,colorNeutralBackground3:p.background,
    colorNeutralBackground4:p.surface,colorNeutralBackground5:p.surface,colorNeutralBackground6:p.surface,
    colorNeutralBackground1Hover:hover,colorNeutralBackground1Selected:selected,colorNeutralBackground1Pressed:selected,
    colorNeutralBackground2Hover:hover,colorNeutralBackground2Selected:selected,colorNeutralBackground2Pressed:selected,
    colorNeutralBackground3Hover:hover,colorNeutralBackground3Selected:selected,colorNeutralBackground3Pressed:selected,
    colorNeutralBackgroundInverted:dark?'#fafafa':'#292929',
    colorNeutralForeground1:p.foreground,colorNeutralForeground2:p.muted,colorNeutralForeground3:p.muted,
    colorNeutralStroke1:p.border,colorNeutralStroke2:p.border,
    colorSubtleBackgroundHover:hover,colorSubtleBackgroundSelected:selected,colorSubtleBackgroundPressed:selected,
    borderRadiusMedium:p.radius+'px',borderRadiusLarge:(p.radius+2)+'px'};
}

export const DEFAULT_ACCENT = "#0f6cbd";

/** 兼容旧引用（无强调色参数时使用 Fluent 默认主题） */
export const micaLightTheme: Theme = { ...webLightTheme, ...lightOverrides };
export const micaDarkTheme: Theme = { ...webDarkTheme, ...darkOverrides };

/* ---------- Hooks ---------- */

function useSystemDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return dark;
}

/** 应用当前生效的深浅色（设置项优先，跟随系统时取系统值） */
export function useIsDark(): boolean {
  const mode = useSettingsStore((s) => s.themeMode);
  const systemDark = useSystemDark();
  return mode === "oled" || mode === "dark" || (mode === "system" && systemDark);
}

export function useAppTheme(): { theme: Theme; dark: boolean } {
  const motion = useMotionPreference();
  const dark = useIsDark();
  const accent = useSettingsStore((s) => s.resolvedAccent);
  const style=useSettingsStore(s=>s.themeMode === "oled" ? "oled" : s.interfaceStyle);
  const density=useSettingsStore(s=>s.density);
  const theme = useMemo(()=>({...buildTheme(dark, accent, style, density),
    curveEasyEase:"cubic-bezier(0.16, 1, 0.3, 1)",
    durationUltraFast:motion === "off"?"0ms":"60ms",
    durationFaster:motion === "off"?"0ms":"90ms",
    durationFast:motion === "off"?"0ms":motion === "reduced"?"90ms":"120ms",
    durationNormal:motion === "off"?"0ms":motion === "reduced"?"90ms":"180ms",
    durationGentle:motion === "off"?"0ms":motion === "reduced"?"90ms":"220ms",
    durationSlow:motion === "off"?"0ms":motion === "reduced"?"90ms":"260ms",
    durationSlower:motion === "off"?"0ms":motion === "reduced"?"90ms":"300ms",
    durationUltraSlow:motion === "off"?"0ms":motion === "reduced"?"90ms":"300ms",
  }),[dark,accent,style,density,motion]);
  useEffect(()=>{document.documentElement.dataset.density=density;},[density]);
  useEffect(()=>{const p=surfaceColors(style,dark); const root=document.documentElement;
    root.dataset.surfaceTheme=style === "oled" || SURFACE_PALETTES[style]?"custom":"default";
    root.dataset.oled=String(style === "oled");
    for (const [key,value] of Object.entries({surface:p.surface,canvas:p.background,ink:p.foreground,muted:p.muted,border:p.border,radius:p.radius+"px"})) root.style.setProperty("--dw-palette-"+key,value);
  },[style,dark]);
  return { theme, dark };
}
