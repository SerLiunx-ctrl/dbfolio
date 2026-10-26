import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link } from "@fluentui/react-components";
import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_RELEASE, CURRENT_RELEASE } from "../../app/releaseInfo";
import { useNotify } from "../../app/toast";
import "./settings.css";

export function AboutContent() {
  const notify = useNotify();
  const link = (label: string, url: string) => <Link href={url} onClick={event => {
    event.preventDefault();
    void openUrl(url).catch(error => notify.error(error, "打开链接失败"));
  }}>{label}</Link>;
  return <div className="dw-about-content">
    <div className="dw-about-product"><strong>DBFolio</strong><span>跨引擎数据库工作台</span></div>
    <div className="dw-about-version"><span>版本 {APP_RELEASE}</span><time dateTime={CURRENT_RELEASE.date}>{CURRENT_RELEASE.date}</time></div>
    <section aria-label="本版更新"><h3>本版更新</h3><ul>{CURRENT_RELEASE.changes.map(change => <li key={change}>{change}</li>)}</ul></section>
    <dl className="dw-about-details">
      <dt>作者</dt><dd>SerLiunx</dd>
      <dt>邮箱</dt><dd>root@serliunx.com</dd>
      <dt>主页</dt><dd>{link("serliunx.com", "https://www.serliunx.com")}</dd>
      <dt>项目</dt><dd>{link("GitHub · DBFolio", "https://github.com/SerLiunx-ctrl/dbfolio")}</dd>
    </dl>
  </div>;
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 关闭动画期间仍保留同一份内容与宽度，不复用布局弹窗的尺寸。
  return <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface className="dw-about-dialog" style={{ width: "min(520px,92vw)", maxWidth: "520px" }}>
      <DialogBody><DialogTitle>关于 DBFolio</DialogTitle><DialogContent><AboutContent /></DialogContent>
        <DialogActions><Button size="small" appearance="primary" onClick={onClose}>关闭</Button></DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>;
}
