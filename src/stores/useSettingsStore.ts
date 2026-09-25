import { create } from "zustand";
import { api } from "../ipc";

export type MotionMode = "system" | "full" | "reduced" | "off";
export type ThemeMode = "system" | "light" | "dark" | "oled";
export type InterfaceStyle = "classic" | "aurora" | "studio" | "ocean" | "forest" | "sand" | "lavender" | "slate" | "rose";
export const INTERFACE_STYLES = [
  { value: "classic", name: "经典简洁", description: "熟悉的平面布局，轻量分隔与淡色条纹。" },
  { value: "aurora", name: "流光层次", description: "渐变标题、柔和卡片与彩色类型标记，层次更鲜明。" },
  { value: "studio", name: "专业工作台", description: "清晰网格、利落边框与等宽数据，方便逐列对照。" },
  { value: "ocean", name: "海盐蓝", description: "清透蓝灰底色，轻盈的工作空间。" },
  { value: "forest", name: "苔原绿", description: "柔和草木底色，低干扰的阅读层次。" },
  { value: "sand", name: "暖砂纸", description: "暖纸色背景，适合长时间阅读。" },
  { value: "lavender", name: "雾紫", description: "柔紫色面板与圆润卡片。" },
  { value: "slate", name: "石墨", description: "中性灰阶与清晰直角边界。" },
  { value: "rose", name: "玫瑰灰", description: "淡玫瑰底色，柔和且简洁。" },
] as const;
const STYLE_KEY = "ui_interface_style";

const THEME_KEY = "ui_theme";
const SIDEBAR_WIDTH_KEY = "ui_sidebar_width";
const SIDEBAR_SPLIT_KEY = "ui_sidebar_split";
const SIDEBAR_COLLAPSED_KEY = "ui_sidebar_collapsed";
const MAX_TABS_KEY = "ui_max_tabs";
const ZOOM_KEY = "ui_zoom";
const ACCENT_KEY = "ui_accent";
const COLLAPSED_FOLDERS_KEY = "ui_collapsed_folders";
const REDIS_TREE_WIDTH_KEY = "ui_redis_tree_width";
const REDIS_PREVIEW_WIDTH_KEY = "ui_redis_preview_width";

export const DEFAULT_SIDEBAR_WIDTH = 300;
export const DEFAULT_SIDEBAR_SPLIT = 0.38;
export const DEFAULT_MAX_TABS = 20;
export const DEFAULT_ZOOM = 1;
export const DEFAULT_ACCENT = "#0f6cbd";
export const DEFAULT_REDIS_TREE_WIDTH = 230;
export const DEFAULT_REDIS_PREVIEW_WIDTH = 380;

export const ACCENT_PRESETS = [
  { name: "Windows 蓝", value: "#0f6cbd" },
  { name: "青色", value: "#038387" },
  { name: "蓝绿", value: "#00b294" },
  { name: "绿色", value: "#107c10" },
  { name: "紫色", value: "#7f3fbf" },
  { name: "品红", value: "#c239b3" },
  { name: "橙红", value: "#ca5010" },
  { name: "红色", value: "#d13438" },
];

interface SettingsState {
  queryPageSize: number;
  setQueryPageSize: (size: number) => Promise<void>;
  motionMode: MotionMode;
  setMotionMode: (mode: MotionMode) => Promise<void>;
  density: "compact" | "comfortable";
  setDensity: (density: "compact" | "comfortable") => Promise<void>;
  interfaceStyle: InterfaceStyle;
  setInterfaceStyle: (style: InterfaceStyle) => Promise<void>;
  themeMode: ThemeMode;
  accent: string;
  resolvedAccent: string;
  sidebarWidth: number;
  rightSidebarWidth: number;
  setRightSidebarWidth: (width: number, persist?: boolean) => void;
  sidebarSplit: number;
  sidebarCollapsed: boolean;
  collapsedFolders: string[];
  wrapTabs: boolean;
  setWrapTabs: (wrap: boolean) => Promise<void>;
  maxTabs: number;
  zoom: number;
  redisTreeWidth: number;
  redisPreviewWidth: number;
  loaded: boolean;
  load: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setAccent: (value: string) => Promise<void>;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setSidebarSplit: (split: number, persist?: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => Promise<void>;
  setFolderCollapsed: (name: string, collapsed: boolean) => Promise<void>;
  setMaxTabs: (count: number) => Promise<void>;
  setZoom: (zoom: number) => Promise<void>;
  setRedisTreeWidth: (width: number, persist?: boolean) => void;
  setRedisPreviewWidth: (width: number, persist?: boolean) => void;
}

function parseMode(raw: string | null): ThemeMode {
  if (raw === "light" || raw === "dark" || raw === "oled") return raw;
  return "system";
}

function parseNumber(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function resolveAccent(mode: string): Promise<string> {
  if (mode === "system") {
    try {
      const system = await api.systemAccentColor();
      if (system && /^#[0-9a-f]{6}$/i.test(system)) return system;
    } catch {
      // 忽略，使用默认强调色
    }
    return DEFAULT_ACCENT;
  }
  return /^#[0-9a-f]{6}$/i.test(mode) ? mode : DEFAULT_ACCENT;
}

// Serialize writes and ignore late system-accent lookups when a newer color was chosen.
let accentRevision = 0;
let accentWrites: Promise<void> = Promise.resolve();
export const useSettingsStore = create<SettingsState>((set, get) => ({
  queryPageSize: 200,
  setQueryPageSize: async (size) => {
    if (!Number.isInteger(size) || size < 1 || size > 5000) throw Error("请输入 1～5000 之间的整数");
    await api.settingsSet("query_page_size", String(size)); set({queryPageSize:size});
  },
  motionMode: "system",
  setMotionMode: async (motionMode) => { await api.settingsSet("ui_motion", motionMode); set({motionMode}); },
  density: "compact",
  setDensity: async (density) => {
    await api.settingsSet("ui_density", density);
    set({ density });
  },
  interfaceStyle: "aurora",
  setInterfaceStyle: async (style) => {
    await api.settingsSet(STYLE_KEY, style);
    set({ interfaceStyle: style });
  },
  themeMode: "system",
  accent: "system",
  resolvedAccent: DEFAULT_ACCENT,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  rightSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarSplit: DEFAULT_SIDEBAR_SPLIT,
  sidebarCollapsed: false,
  collapsedFolders: [],
  wrapTabs: false,
  setWrapTabs: async (wrapTabs) => { await api.settingsSet("ui_wrap_tabs", wrapTabs ? "1" : "0"); set({ wrapTabs }); },
  maxTabs: DEFAULT_MAX_TABS,
  zoom: DEFAULT_ZOOM,
  redisTreeWidth: DEFAULT_REDIS_TREE_WIDTH,
  redisPreviewWidth: DEFAULT_REDIS_PREVIEW_WIDTH,
  loaded: false,

  load: async () => {
    try {
      const [
        theme,
        sidebar,
        split,
        collapsed,
        pageSizeRaw,
        motionRaw,
        maxTabsRaw,
        zoom,
        accentRaw,
        folders,
        redisTree,
        redisPreview,
        interfaceStyle,
        rightSidebar,
        density,
        wrapTabs,
      ] = await Promise.all([
        api.settingsGet(THEME_KEY),
        api.settingsGet(SIDEBAR_WIDTH_KEY),
        api.settingsGet(SIDEBAR_SPLIT_KEY),
        api.settingsGet(SIDEBAR_COLLAPSED_KEY),
        api.settingsGet("query_page_size"),
        api.settingsGet("ui_motion"),
        api.settingsGet(MAX_TABS_KEY),
        api.settingsGet(ZOOM_KEY),
        api.settingsGet(ACCENT_KEY),
        api.settingsGet(COLLAPSED_FOLDERS_KEY),
        api.settingsGet(REDIS_TREE_WIDTH_KEY),
        api.settingsGet(REDIS_PREVIEW_WIDTH_KEY),
        api.settingsGet(STYLE_KEY),
        api.settingsGet("ui_right_sidebar_width"),
        api.settingsGet("ui_density"),
        api.settingsGet("ui_wrap_tabs"),
      ]);
      if (rightSidebar === null) await api.settingsSet("ui_right_sidebar_width", String(parseNumber(sidebar, DEFAULT_SIDEBAR_WIDTH, 200, 460)));
      const accent = accentRaw ?? "system";
      const resolvedAccent = await resolveAccent(accent);
      let collapsedFolders: string[] = [];
      try {
        const parsed = folders ? (JSON.parse(folders) as unknown) : [];
        if (Array.isArray(parsed)) {
          collapsedFolders = parsed.filter(
            (item): item is string => typeof item === "string",
          );
        }
      } catch {
        collapsedFolders = [];
      }
      set({
        queryPageSize: Math.round(parseNumber(pageSizeRaw, 200, 1, 5000)),
        motionMode: ["full", "reduced", "off"].includes(motionRaw ?? "") ? motionRaw as MotionMode : "system",
        wrapTabs: wrapTabs === "1",
        density: density === "comfortable" ? "comfortable" : "compact",
        themeMode: parseMode(theme),
        interfaceStyle: INTERFACE_STYLES.some(item => item.value === interfaceStyle) ? interfaceStyle as InterfaceStyle : "aurora",
        accent,
        resolvedAccent,
        sidebarWidth: parseNumber(sidebar, DEFAULT_SIDEBAR_WIDTH, 200, 460),
        rightSidebarWidth: parseNumber(rightSidebar ?? sidebar, DEFAULT_SIDEBAR_WIDTH, 200, 460),
        sidebarSplit: parseNumber(split, DEFAULT_SIDEBAR_SPLIT, 0.2, 0.8),
        sidebarCollapsed: collapsed === "1",
        collapsedFolders,
        maxTabs: Math.round(parseNumber(maxTabsRaw, DEFAULT_MAX_TABS, 0, 500)),
        zoom: parseNumber(zoom, DEFAULT_ZOOM, 0.6, 2),
        redisTreeWidth: parseNumber(redisTree, DEFAULT_REDIS_TREE_WIDTH, 160, 480),
        redisPreviewWidth: parseNumber(redisPreview, DEFAULT_REDIS_PREVIEW_WIDTH, 240, 720),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  setThemeMode: async (mode) => {
    set({ themeMode: mode });
    await api.settingsSet(THEME_KEY, mode);
  },

  setAccent: async (value) => {
    const revision = ++accentRevision;
    const resolvedAccent = await resolveAccent(value);
    if (revision !== accentRevision) return;
    const write = accentWrites.catch(()=>undefined).then(async()=>{
      await api.settingsSet(ACCENT_KEY, value);
      // Reflect each successful serialized commit, including when a later request fails.
      set({ accent: value, resolvedAccent });
    });
    accentWrites = write;
    await write;
  },

  setSidebarWidth: (width, persist = true) => {
    const clamped = Math.min(460, Math.max(200, Math.round(width)));
    set({ sidebarWidth: clamped });
    if (persist) void api.settingsSet(SIDEBAR_WIDTH_KEY, String(clamped));
  },

  setRightSidebarWidth: (width, persist = true) => {
    const clamped = Math.min(460, Math.max(200, Math.round(width)));
    set({ rightSidebarWidth: clamped });
    if (persist) void api.settingsSet("ui_right_sidebar_width", String(clamped));
  },

  setSidebarSplit: (split, persist = true) => {
    const clamped = Math.min(0.8, Math.max(0.2, Math.round(split * 1000) / 1000));
    set({ sidebarSplit: clamped });
    if (persist) void api.settingsSet(SIDEBAR_SPLIT_KEY, String(clamped));
  },

  setSidebarCollapsed: async (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    await api.settingsSet(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  },

  setFolderCollapsed: async (name, collapsed) => {
    const current = get().collapsedFolders;
    const next = collapsed
      ? current.includes(name)
        ? current
        : [...current, name]
      : current.filter((item) => item !== name);
    set({ collapsedFolders: next });
    await api.settingsSet(COLLAPSED_FOLDERS_KEY, JSON.stringify(next));
  },

  setMaxTabs: async (count) => {
    const clamped = Math.min(500, Math.max(0, Math.round(count)));
    set({ maxTabs: clamped });
    await api.settingsSet(MAX_TABS_KEY, String(clamped));
  },

  setZoom: async (zoom) => {
    const clamped = Math.min(2, Math.max(0.6, Math.round(zoom * 100) / 100));
    set({ zoom: clamped });
    await api.settingsSet(ZOOM_KEY, String(clamped));
  },

  setRedisTreeWidth: (width, persist = true) => {
    const clamped = Math.min(480, Math.max(160, Math.round(width)));
    set({ redisTreeWidth: clamped });
    if (persist) void api.settingsSet(REDIS_TREE_WIDTH_KEY, String(clamped));
  },

  setRedisPreviewWidth: (width, persist = true) => {
    const clamped = Math.min(720, Math.max(240, Math.round(width)));
    set({ redisPreviewWidth: clamped });
    if (persist) void api.settingsSet(REDIS_PREVIEW_WIDTH_KEY, String(clamped));
  },
}));
