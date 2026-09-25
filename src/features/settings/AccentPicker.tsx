import {InfoHint} from '../../common/InfoHint';
import { memo, useEffect, useState } from "react";
import { Button, Field } from "@fluentui/react-components";

interface Props {
  value: string;
  onApply: (value: string) => Promise<void>;
}

// Color input emits on every pointer movement. Keep that traffic inside this leaf:
// no global theme/store update or IPC until the user applies the chosen color.
export const AccentPicker = memo(function AccentPicker({ value, onApply }: Props) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(value); setError(""); }, [value]);
  const dirty = draft.toLowerCase() !== value.toLowerCase();
  const apply = async () => {
    if (saving || !dirty) return;
    setSaving(true); setError("");
    try { await onApply(draft); }
    catch { setError("配色保存失败，已保留所选颜色，请重试。"); }
    finally { setSaving(false); }
  };
  return <Field label="自定义强调色" hint={<InfoHint label="强调色说明">拖动仅预览，点击应用后更新界面。</InfoHint>}>
    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <input type="color" aria-label="自定义强调色" value={draft} disabled={saving}
        onChange={event=>{setDraft(event.target.value);setError("");}} />
      <code style={{fontSize:12}}>{draft}</code>
      <span aria-hidden="true" style={{padding:"3px 9px",borderRadius:4,border:"1px solid "+draft,color:draft}}>强调色预览</span>
      <Button appearance="primary" disabled={saving||!dirty} onClick={()=>void apply()}>{saving?"应用中…":"应用配色"}</Button>
      {dirty&&<Button appearance="subtle" disabled={saving} onClick={()=>{setDraft(value);setError("");}}>还原</Button>}
    </div>
    {error&&<span role="alert" style={{color:"var(--colorStatusDangerForeground1)"}}>{error}</span>}
  </Field>;
});
