import {useShortcutLabel} from '../../app/shortcuts';
import {ShortcutEditor} from './ShortcutEditor';
import { ConfigTransferSettings } from "./ConfigTransferSettings";
import { UpdatePanel } from '../updates/UpdatePanel';
import { AboutContent } from "./AboutContent";
import "./settings.css";
import {QueryPageSettings} from "./QueryPageSettings";
import {InfoHint} from '../../common/InfoHint';
import { LocalDataSettings } from "./LocalDataSettings";
import { AiSettings } from "./AiSettings";
import { useDockStore } from "../../stores/useDockStore";
import { useIsDark } from "../../theme";
import { surfaceColors } from "../../appearance";
import { AccentPicker } from "./AccentPicker";
import {
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { ArrowDownloadRegular, ArrowSyncRegular, BotRegular, CheckmarkRegular, DatabaseRegular, GridRegular, InfoRegular, KeyboardRegular, PaintBrushRegular, SearchRegular, WindowRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import { useNotify } from "../../app/toast";
import {
  ACCENT_PRESETS,
  INTERFACE_STYLES,
  useSettingsStore,
  type ThemeMode,
  type MotionMode,
} from "../../stores/useSettingsStore";

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
  },
  nav: {
    width: "164px",
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: "10px 8px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    overflowY: "auto",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    border: "none",
    background: "transparent",
    textAlign: "left",
    padding: "5px 10px 5px 14px",
    borderRadius: "6px",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "20px",
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
    ":focus-visible": { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: "-2px" },
  },
  navItemActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: "auto",
    padding: "var(--dw-panel-padding)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--dw-section-gap)",
    maxWidth: "960px",
    boxSizing: "border-box",
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    maxWidth: "520px",
    paddingBottom: "10px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  note: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: "18px",
  },
  swatches: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
  },
  swatch: {
    width: "24px",
    height: "24px",
    borderRadius: "50%",
    border: "none",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#ffffff",
    transition: "transform 120ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { transform: "scale(1.12)" },
  },
  swatchSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorBrandStroke1}`,
  },
  systemSwatch: {
    width: "auto",
    height: "24px",
    borderRadius: "12px",
    padding: "0 10px",
    fontSize: tokens.fontSizeBase100,
    cursor: "pointer",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    background: "transparent",
    color: tokens.colorNeutralForeground2,
  },
});

const CATEGORIES = [
  { id: "appearance", label: "外观", icon: PaintBrushRegular, group: "界面与操作", keywords: "主题 配色 强调色 动效" },
  { id: "layout", label: "布局与缩放", icon: WindowRegular, group: "界面与操作", keywords: "面板 停靠 密度 页签" },
  { id: "shortcuts", label: "快捷键", icon: KeyboardRegular, group: "界面与操作", keywords: "键盘 快速打开" },
  { id: "grid", label: "数据浏览", icon: GridRegular, group: "数据与服务", keywords: "数据网格 查询 分页 每页 行数" },
  { id: "ai", label: "AI 服务", icon: BotRegular, group: "数据与服务", keywords: "模型 密钥 服务商" },
  { id: "localData", label: "本机数据", icon: DatabaseRegular, group: "应用管理", keywords: "历史 清理 缓存" },
  { id: "configTransfer", label: "配置迁移", icon: ArrowSyncRegular, group: "应用管理", keywords: "导入 导出 会话" },
  { id: "updates", label: "软件更新", icon: ArrowDownloadRegular, group: "应用管理", keywords: "版本 代理 通道 升级" },
  { id: "about", label: "关于", icon: InfoRegular, group: "应用管理", keywords: "版本 更新内容 作者" },
];
const CATEGORY_GROUPS = ["界面与操作", "数据与服务", "应用管理"];

export function SettingsWorkspace({initialCategory="appearance"}:{initialCategory?:string}) {
  const zoomInKey=useShortcutLabel('zoomIn'),zoomOutKey=useShortcutLabel('zoomOut'),zoomResetKey=useShortcutLabel('zoomReset'),sidebarKey=useShortcutLabel('sidebar');
  const styles = useStyles();
  const dark = useIsDark();
  const notify = useNotify();
  const interfaceStyle = useSettingsStore((s) => s.interfaceStyle);
  const density = useSettingsStore(s=>s.density);
  const setDensity = useSettingsStore(s=>s.setDensity);
  const setInterfaceStyle = useSettingsStore((s) => s.setInterfaceStyle);
  const [savingStyle, setSavingStyle] = useState(false);
  const [category, setCategory] = useState(initialCategory);
  const [search, setSearch] = useState("");
  useEffect(()=>{setCategory(CATEGORIES.some(c=>c.id===initialCategory)?initialCategory:"appearance");setSearch("");},[initialCategory]);
  const categories = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return CATEGORIES.filter(item => `${item.group} ${item.label} ${item.keywords}`.toLocaleLowerCase().includes(query));
  }, [search]);

  const motionMode = useSettingsStore(s=>s.motionMode);
  const setMotionMode = useSettingsStore(s=>s.setMotionMode);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const accent = useSettingsStore((s) => s.accent);
  const resolvedAccent = useSettingsStore((s) => s.resolvedAccent);
  const wrapTabs = useSettingsStore(s => s.wrapTabs);
  const setWrapTabs = useSettingsStore(s => s.setWrapTabs);
  const maxTabs = useSettingsStore((s) => s.maxTabs);
  const zoom = useSettingsStore((s) => s.zoom);
  const [draftZoom, setDraftZoom] = useState(Math.round(zoom * 100));
  const [savingZoom, setSavingZoom] = useState(false);
  useEffect(() => { setDraftZoom(Math.round(zoom * 100)); }, [zoom]);
  const rightSidebarWidth = useSettingsStore(s=>s.rightSidebarWidth);
  const setRightSidebarWidth = useSettingsStore(s=>s.setRightSidebarWidth);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const sidebarSplit = useSettingsStore((s) => s.sidebarSplit);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const setMaxTabs = useSettingsStore((s) => s.setMaxTabs);
  const setZoom = useSettingsStore((s) => s.setZoom);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const setSidebarSplit = useSettingsStore((s) => s.setSidebarSplit);

  const applyZoom = async (value: number) => {
    if (savingZoom) return;
    setSavingZoom(true);
    try { await setZoom(value / 100); }
    catch (error) { notify.error(error, "保存缩放比例失败"); }
    finally { setSavingZoom(false); }
  };

  const current = CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0];

  return (
    <div className={styles.root}>
      <nav className={styles.nav} aria-label="首选项分类">
        <Input size="small" className="dw-settings-nav-search" contentBefore={<SearchRegular />} aria-label="搜索设置" placeholder="搜索设置" value={search} onChange={(_, data) => setSearch(data.value)} />
        {CATEGORY_GROUPS.map(group => {
          const items = categories.filter(item => item.group === group);
          if (!items.length) return null;
          return <section className="dw-settings-nav-group" aria-label={group} key={group}>
          <h3 className="dw-settings-nav-heading">{group}</h3>
          {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mergeClasses(
              styles.navItem, "dw-settings-nav-item",
              item.id === category && styles.navItemActive,
            )}
            onClick={() => setCategory(item.id)}
            aria-current={item.id === category ? "page" : undefined}
          >
            <item.icon className="dw-settings-nav-icon" aria-hidden="true" />
            <span>{item.label}</span>
          </button>
          ))}</section>;
        })}
        {!categories.length && <span className={styles.note} role="status">没有匹配的设置</span>}
      </nav>
      <main className={mergeClasses(styles.content, "dw-settings-content")} aria-label={current.label}>
        <header className="dw-settings-heading"><div className={styles.title}>{current.label}</div><span>{current.group}</span></header>
        {current.id === "layout" && <section className={styles.section}>
          <Field label="界面密度">
            <RadioGroup layout="horizontal" value={density} onChange={(_,d)=>void setDensity(d.value as "compact"|"comfortable").catch(e=>notify.error(e))}>
              <Radio value="compact" label="紧凑（推荐）"/><Radio value="comfortable" label="舒适"/>
            </RadioGroup>
          </Field>
          <InfoHint label="界面密度说明">调整控件、表单和弹窗的间距，不改变界面缩放及数据网格行高。</InfoHint>
        </section>}

        {category === "ai" && <AiSettings/>}
        {category === "localData" && <LocalDataSettings/>}
        {category === "configTransfer" && <ConfigTransferSettings/>}
        {category === "updates" && <UpdatePanel/>}
        {category === "about" && <AboutContent/>}
        {category === "appearance" && (
          <>
            <div className={styles.section}>
              <Field label="界面配色">
                <RadioGroup layout="horizontal"
                  value={themeMode}
                  onChange={(_, data) => void setThemeMode(data.value as ThemeMode)}
                >
                  <Radio value="system" label="跟随系统" />
                  <Radio value="light" label="亮色" />
                  <Radio value="dark" label="暗色" />
                  <Radio value="oled" label="纯黑（OLED）" />
                </RadioGroup>
              </Field>
            </div>
            <div className={styles.section}>
              <Field label="强调色">
                <div className={styles.swatches}>
                  <button
                    type="button"
                    className={mergeClasses(
                      styles.systemSwatch,
                      accent === "system" && styles.swatchSelected,
                    )}
                    onClick={() => void setAccent("system").catch(e=>notify.error(e,"配色保存失败"))}
                  >
                    跟随系统
                  </button>
                  {ACCENT_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      title={preset.name}
                      className={mergeClasses(
                        styles.swatch,
                        accent === preset.value && styles.swatchSelected,
                      )}
                      style={{ backgroundColor: preset.value }}
                      onClick={() => void setAccent(preset.value).catch(e=>notify.error(e,"配色保存失败"))}
                    >
                      {accent === preset.value && <CheckmarkRegular fontSize={14} />}
                    </button>
                  ))}
                </div>
              </Field>
              <AccentPicker key={accent} value={resolvedAccent} onApply={setAccent}/>
              <div className={styles.note}>
                当前生效：
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    margin: "0 4px",
                    backgroundColor: resolvedAccent,
                  }}
                />
                {resolvedAccent}
                {accent === "system" ? "（来自 Windows 系统设置）" : ""}
              </div>
            </div>
          </>
        )}

        {category === "appearance" && <Field label="界面动效">
          <RadioGroup layout="horizontal" value={motionMode} onChange={(_,d)=>void setMotionMode(d.value as MotionMode).catch(e=>notify.error(e,"保存动效偏好失败"))}>
            <Radio value="system" label="跟随系统"/><Radio value="full" label="完整"/><Radio value="reduced" label="减弱"/><Radio value="off" label="关闭"/>
          </RadioGroup>
          <InfoHint label="界面动效说明">跟随系统的减少动态效果偏好。减弱模式仅保留短暂淡入和颜色过渡；关闭模式立即切换，运行状态仍用文字和图标表示。</InfoHint>
        </Field>}

        {category === "appearance" && <>
            <details className="dw-style-gallery" aria-label="界面风格">
              <summary>界面风格 · {INTERFACE_STYLES.find(item => item.value === interfaceStyle)?.name}</summary>

              <div className="dw-style-options">
                {INTERFACE_STYLES.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    className="dw-style-option"
                    data-preview={item.value}
                    style={{"--preview-surface":surfaceColors(themeMode === "oled" ? "oled" : item.value,dark).surface,"--preview-ink":surfaceColors(themeMode === "oled" ? "oled" : item.value,dark).foreground} as React.CSSProperties}
                    aria-pressed={interfaceStyle === item.value}
                    disabled={savingStyle}
                    onClick={async () => {
                      setSavingStyle(true);
                      try { await setInterfaceStyle(item.value); }
                      catch (error) { notify.error(error); }
                      finally { setSavingStyle(false); }
                    }}
                  >
                    <span className="dw-style-preview" aria-hidden="true">
                      <span className="dw-preview-sidebar"><i /><i /><i /></span>
                      <span className="dw-preview-workspace">
                        <span className="dw-preview-heading">数据工作区</span>
                        <span className="dw-preview-columns"><b>id</b><b>title</b><b>created_at</b></span>
                        {[1, 2, 3].map((row) => <span className="dw-preview-row" key={row}><i /><i /><i /></span>)}
                      </span>
                    </span>
                    <span className="dw-style-name">{item.name}{interfaceStyle === item.value && <CheckmarkRegular />}</span>
                    <span className="dw-style-description">{item.description}</span>
                  </button>
                ))}
              </div>
              <InfoHint label="主题说明">选择后立即生效并自动保存。预览跟随当前配色，风格与强调色均会保留。</InfoHint>
            </details>
        </>}

        {category === "layout" && (
          <>
            <div className={styles.section}>
              <Button onClick={()=>window.dispatchEvent(new Event("dw:layouts"))}>布局预设与保存当前布局…</Button>
              <Field label="面板停靠" hint={<InfoHint label="面板停靠说明">拖动标题到左右边缘；同侧可上下排列。</InfoHint>}>
                <Button onClick={() => void useDockStore.getState().reset().catch(error => notify.error(error, "恢复布局失败"))}>恢复默认停靠</Button>
              </Field>
            </div>
            <div className={styles.section}>
              <Field label={`界面缩放（${draftZoom}%）`}>
                <Slider
                  min={60}
                  max={200}
                  step={5}
                  value={draftZoom}
                  disabled={savingZoom}
                  onChange={(_, data) => setDraftZoom(data.value)}
                />
              </Field>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Button appearance="primary" disabled={savingZoom || draftZoom === Math.round(zoom * 100)} onClick={() => void applyZoom(draftZoom)}>
                  {savingZoom ? "应用中…" : "应用缩放"}
                </Button>
                <Button disabled={savingZoom || (zoom === 1 && draftZoom === 100)} onClick={() => { setDraftZoom(100); void applyZoom(100); }}>恢复 100%</Button>
                <span className={styles.note} role="status">当前已应用 {Math.round(zoom * 100)}%{draftZoom !== Math.round(zoom * 100) ? " · 新比例尚未应用" : ""}</span>
              </div>
              <InfoHint label="缩放说明">拖动滑块只选择比例，点击「应用缩放」后生效，避免调节时滑轨移动。</InfoHint>
              <InfoHint label="缩放快捷键">
                快捷键：{zoomInKey} 放大、{zoomOutKey} 缩小、{zoomResetKey} 恢复，或在右侧区域按住
                Ctrl 滚动鼠标。
              </InfoHint>
            </div>
            <div className={styles.section}>
              <Switch label="页签超出宽度时换行" checked={wrapTabs} onChange={(_, data) => { void setWrapTabs(data.checked).catch(error => notify.error(error, "保存设置失败")); }} />
              <Field label="页签最多数量">
                <Dropdown
                  selectedOptions={[String(maxTabs)]}
                  value={maxTabs === 0 ? "不限制" : `${maxTabs} 个`}
                  onOptionSelect={(_, data) => {
                    if (data.optionValue) void setMaxTabs(Number(data.optionValue));
                  }}
                >
                  {[10, 20, 30, 50, 0].map((count) => (
                    <Option
                      key={count}
                      value={String(count)}
                      text={count === 0 ? "不限制" : `${count} 个`}
                    >
                      {count === 0 ? "不限制" : `${count} 个`}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <InfoHint label="页签数量说明">
                超过数量上限时会自动关闭最早打开的页签（置顶页签不参与计数）。
              </InfoHint>
            </div>
            <div className={styles.section}>
              <Field label={`左侧面板宽度（${sidebarWidth}px）`}>
                <Slider
                  min={200}
                  max={460}
                  step={10}
                  value={sidebarWidth}
                  onChange={(_, data) => setSidebarWidth(data.value, true)}
                />
              </Field>
              <Field label={`右侧面板宽度（${rightSidebarWidth}px）`}><Slider min={200} max={460} step={10} value={rightSidebarWidth} onChange={(_, data)=>setRightSidebarWidth(data.value,true)} /></Field>
              <Field label={`同侧上下比例（上方面板 ${Math.round(sidebarSplit * 100)}%）`}>
                <Slider
                  min={20}
                  max={80}
                  step={5}
                  value={Math.round(sidebarSplit * 100)}
                  onChange={(_, data) => setSidebarSplit(data.value / 100, true)}
                />
              </Field>
              <InfoHint label="面板快捷键">
                提示：{sidebarKey} 收起/展开两侧面板；拖动标题可以停靠，拖动分隔条可以调整尺寸。
              </InfoHint>
            </div>
          </>
        )}

        {category === "shortcuts" && <ShortcutEditor/>}
        {category === "grid" && <QueryPageSettings/>}
      </main>
    </div>
  );
}
