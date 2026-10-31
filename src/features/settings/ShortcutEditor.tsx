import {useEffect,useRef,useState} from 'react';
import {Button,Input} from '@fluentui/react-components';
import {ArrowResetRegular,DeleteRegular,SaveRegular} from '@fluentui/react-icons';
import {SHORTCUTS,bindingsErrors,defaultBindings,displayShortcut,eventShortcut,type ShortcutId} from '../../app/shortcutModel';
import {useShortcut,useShortcutLabel} from '../../app/shortcuts';
import {useShortcutStore} from '../../stores/useShortcutStore';
import './shortcuts.css';
export function ShortcutEditor(){
 const state=useShortcutStore(),[draft,setDraft]=useState(state.bindings),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[recording,setRecording]=useState<ShortcutId|null>(null),root=useRef<HTMLDivElement>(null),lock=useRef(false);
 useEffect(()=>{void state.load().catch(e=>setError(String(e?.message??e)));},[]);useEffect(()=>setDraft(state.bindings),[state.bindings]);
 const errors=bindingsErrors(draft),dirty=JSON.stringify(draft)!==JSON.stringify(state.bindings),saveKey=useShortcutLabel('save');
 const save=async()=>{if(lock.current||!dirty||errors.length)return;lock.current=true;setSaving(true);setError('');try{await state.save(draft);setNotice('快捷键已保存并立即生效');}catch(e){setError(String((e as Error).message??e));}finally{lock.current=false;setSaving(false);}};
 useShortcut('save',()=>{if(!root.current?.getBoundingClientRect().width)return false;void save();},true,80);
 return <div ref={root} className="dw-shortcuts"><div className="dw-shortcuts-actions"><Button size="small" appearance="primary" icon={<SaveRegular/>} disabled={!dirty||saving||!!errors.length||!state.loaded} onClick={()=>void save()} title={saveKey}>保存</Button><Button size="small" disabled={!dirty||saving} onClick={()=>{setDraft(state.bindings);setError('');}}>废弃</Button><Button size="small" icon={<ArrowResetRegular/>} disabled={saving} onClick={()=>{setDraft(defaultBindings());setNotice('已恢复默认草稿，保存后生效');}}>恢复全部默认</Button></div>
 <small>全部为应用内快捷键，仅在 DBFolio 窗口中生效，不注册系统级全局热键。不支持 Windows 保留组合；系统或其它软件占用的按键可能无法收到。</small><small>点击按键栏后按下组合键；Delete 清空，Esc 取消录入。修改后保存生效。编辑器内复制、粘贴、文本撤销等原生按键保持不变。</small>
 {error&&<p role="alert">{error}</p>}{errors.map(e=><p role="alert" key={e}>{e}</p>)}{notice&&<p role="status">{notice}</p>}
 <div className="dw-shortcuts-list">{SHORTCUTS.map(s=><div className="dw-shortcut-row" key={s.id}><label htmlFor={'shortcut-'+s.id}><strong>{s.label}</strong><small>{s.scope}</small></label><Input size="small" id={'shortcut-'+s.id} aria-label={s.label+'快捷键'} data-shortcut-recorder readOnly value={recording===s.id?'请按组合键…':displayShortcut(draft[s.id])} disabled={saving||!state.loaded} onFocus={()=>setRecording(s.id)} onBlur={()=>setRecording(null)} onKeyDown={e=>{e.preventDefault();e.stopPropagation();if(e.key==='Escape'){e.currentTarget.blur();return;}if((e.key==='Delete'||e.key==='Backspace')&&!e.ctrlKey&&!e.altKey&&!e.shiftKey){setDraft(v=>({...v,[s.id]:''}));e.currentTarget.blur();return;}if(e.metaKey){setError('Windows 键组合由系统保留，请使用 Ctrl / Alt / Shift');return;}const key=eventShortcut(e);if(!key)return;setError('');setNotice('');setDraft(v=>({...v,[s.id]:key}));e.currentTarget.blur();}}/><Button size="small" appearance="subtle" icon={<DeleteRegular/>} aria-label={'清空'+s.label+'快捷键'} disabled={saving} onClick={()=>setDraft(v=>({...v,[s.id]:''}))}/><Button size="small" appearance="subtle" icon={<ArrowResetRegular/>} aria-label={'恢复'+s.label+'默认快捷键'} disabled={saving} onClick={()=>setDraft(v=>({...v,[s.id]:s.key}))}/></div>)}</div></div>;
}
