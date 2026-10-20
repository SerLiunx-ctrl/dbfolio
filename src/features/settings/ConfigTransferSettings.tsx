import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open,save} from '@tauri-apps/plugin-dialog';
import {Button,Checkbox,Dialog,DialogActions,DialogBody,DialogContent,DialogSurface,DialogTitle,Field,Select,Spinner,tokens} from '@fluentui/react-components';
import type {SessionRecord,HistoryEntry} from '../../ipc/types';
import type {FilterPreset} from '../../stores/useLibrary';
import type {AnalysisPlan} from '../analysis/model';
import type {BusinessRelation} from '../relations/model';
import type {Environment,FavoriteObject} from '../../stores/useObjectPreferences';
import {useSessionStore} from '../../stores/useSessionStore';
import {useTabStore} from '../../stores/useTabStore';
import {useEditGuard} from '../../stores/useEditGuard';
import {useTaskStore,isTaskActive,errorText} from '../../stores/useTaskStore';
import {flushWorkspace} from '../../stores/useWorkspace';
import {api} from '../../ipc';
import './config-transfer.css';

interface Bundle {
  format:string;version:number;appVersion:string;exportedAt:string;
  sessions:SessionRecord[];folders:string[];preferences:Record<string,string>;
  favorites:HistoryEntry[];filters:FilterPreset[];analyses:AnalysisPlan[];relations:BusinessRelation[];
  environments:Record<string,Environment>;objectFavorites:FavoriteObject[];
}
interface Preview {
  fingerprint:string;sessions:{name:string;engine:string;action:string;targetName:string}[];
  added:Record<string,number>;skipped:Record<string,number>;preferences:number;folders:number;warnings:string[];
}
const categories=[['preferences','首选项'],['favorites','收藏 SQL'],['filters','筛选方案'],['analyses','分析方案'],['relations','业务关联']] as const;
type Category=typeof categories[number][0];
type Choices=Record<Category,boolean>;
const initialChoices:Choices={preferences:true,favorites:true,filters:true,analyses:true,relations:true};
type Mode='copy'|'merge'|'skip';
const fileFilters=[{name:'DBFolio 配置',extensions:['json']}];

function selectBundle(bundle:Bundle,ids:string[],folders:string[],choices:Choices):Bundle {
  const selected=new Set(ids),sessions=bundle.sessions.filter(s=>selected.has(s.id));
  return {...bundle,sessions,folders:[...new Set([...folders,...sessions.flatMap(s=>s.groupName?[s.groupName]:[])])],
    preferences:choices.preferences?bundle.preferences:{},
    favorites:choices.favorites?bundle.favorites.filter(v=>selected.has(v.sessionId)):[],
    filters:choices.filters?bundle.filters.filter(v=>selected.has(JSON.parse(v.scope)[0])):[],
    analyses:choices.analyses?bundle.analyses.filter(v=>selected.has(v.sessionId)):[],
    relations:choices.relations?bundle.relations.filter(v=>selected.has(v.source.sessionId)):[],
    environments:Object.fromEntries(Object.entries(bundle.environments).filter(([id])=>selected.has(id))),
    objectFavorites:bundle.objectFavorites.filter(v=>selected.has(v.sessionId)),
  };
}
function importBlocked():boolean {
  return useTabStore.getState().tabs.length>0 || Object.keys(useEditGuard.getState().entries).length>0 ||
    useTaskStore.getState().tasks.some(isTaskActive) || Object.values(useSessionStore.getState().statuses).some(s=>s.connected) ||
    Object.values(useSessionStore.getState().phases).some(s=>s.state==='connecting');
}

export function ConfigTransferSettings(){
  const [tab,setTab]=useState<'export'|'import'>('export');
  const [sessions,setSessions]=useState<SessionRecord[]>([]),[folders,setFolders]=useState<string[]>([]);
  const [ids,setIds]=useState<string[]>([]),[selectedFolders,setSelectedFolders]=useState<string[]>([]);
  const [choices,setChoices]=useState<Choices>(initialChoices),[mode,setMode]=useState<Mode>('copy');
  const [bundle,setBundle]=useState<Bundle|null>(null),[preview,setPreview]=useState<Preview|null>(null);
  const [busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[applying,setApplying]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[file,setFile]=useState('');
  const lock=useRef(false);
  const tabs=useTabStore(s=>s.tabs),statuses=useSessionStore(s=>s.statuses),phases=useSessionStore(s=>s.phases);
  const tasks=useTaskStore(s=>s.tasks),edits=useEditGuard(s=>s.entries);
  const blocked=tabs.length>0||Object.keys(edits).length>0||tasks.some(isTaskActive)||Object.values(statuses).some(s=>s.connected)||Object.values(phases).some(s=>s.state==='connecting');
  const run=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(errorText(e));}finally{lock.current=false;setBusy(false);}};
  const refresh=async()=>{const [items,raw]=await Promise.all([api.listSessions(),api.settingsGet('session_folders')]);const groups=[...new Set<string>([...(raw?JSON.parse(raw):[]),...items.flatMap(s=>s.groupName?[s.groupName]:[])])];setSessions(items);setFolders(groups);setIds(items.map(s=>s.id));setSelectedFolders(groups);setPreview(null);};
  useEffect(()=>{void run(refresh);},[]);
  const sourceSessions=tab==='export'?sessions:bundle?.sessions??[];
  const sourceFolders=tab==='export'?folders:bundle?.folders??[];
  const groupNames=[...new Set([...sourceFolders,...sourceSessions.map(s=>s.groupName??'')])];
  const invalidate=()=>{setPreview(null);setError('');setMessage('');};
  const selectGroup=(name:string,checked:boolean)=>{
    invalidate();const members=sourceSessions.filter(s=>(s.groupName??'')===name).map(s=>s.id);
    setIds(previous=>checked?[...new Set([...previous,...members])]:previous.filter(id=>!members.includes(id)));
    if(name)setSelectedFolders(previous=>checked?[...new Set([...previous,name])]:previous.filter(s=>s!==name));
  };
  const changeTab=(next:'export'|'import')=>{setTab(next);invalidate();setChoices(initialChoices);setIds(next==='export'?sessions.map(s=>s.id):bundle?.sessions.map(s=>s.id)??[]);setSelectedFolders(next==='export'?folders:bundle?.folders??[]);};
  const read=async()=>{const path=await open({multiple:false,filters:fileFilters});if(typeof path!=='string')return;setBundle(null);setPreview(null);setIds([]);setFile('');const data=await invoke<Bundle>('config_read',{path});setBundle(data);setFile(path);setIds(data.sessions.map(s=>s.id));setSelectedFolders(data.folders);setChoices(initialChoices);};
  const chosen=()=>selectBundle(bundle!,ids,selectedFolders,choices);
  const options=()=>({mode,preferences:choices.preferences});
  const apply=async()=>{
    if(!bundle||!preview)return;
    if(importBlocked())throw Error('请先关闭工作标签页、结束任务并断开所有会话，再导入配置。');
    setApplying(true);
    try {await flushWorkspace();await invoke('config_import',{bundle:chosen(),options:options(),fingerprint:preview.fingerprint});window.location.reload();}
    catch(e){setConfirm(false);setApplying(false);setPreview(null);throw e;}
  };
  return <section className="config-transfer" aria-label="配置迁移">
    <div className="config-transfer-toolbar"><Button size="small" appearance={tab==='export'?'primary':'secondary'} disabled={busy} onClick={()=>changeTab('export')}>导出配置</Button><Button size="small" appearance={tab==='import'?'primary':'secondary'} disabled={busy} onClick={()=>changeTab('import')}>导入配置</Button>{busy&&<Spinner size="tiny"/>}</div>
    <p className="config-transfer-note">迁移会话及相关方案，不包含数据库数据、查询历史、工作草稿和 AI 密钥。密码与 SSH 口令不会导出，证书和 SQLite 文件仅保留路径。</p>
    {error&&<div role="alert" style={{color:tokens.colorPaletteRedForeground1}}>{error}</div>}
    {message&&<div role="status">{message}</div>}
    {tab==='import'&&<div className="config-transfer-toolbar"><Button size="small" disabled={busy} onClick={()=>void run(read)}>选择配置文件…</Button><span className="config-transfer-path">{file||'请选择 DBFolio 导出的 JSON 文件'}</span></div>}
    {tab==='import'&&bundle&&<div className="config-transfer-note">来源版本 {bundle.appVersion} · 导出时间 {bundle.exportedAt} · 格式版本 {bundle.version}</div>}
    {(tab==='export'||bundle)&&<>
      <div className="config-transfer-toolbar"><strong>会话与分组 · 已选 {ids.length} / {sourceSessions.length}</strong><Button size="small" disabled={busy} onClick={()=>{invalidate();setIds(sourceSessions.map(s=>s.id));setSelectedFolders(sourceFolders);}}>全选</Button><Button size="small" disabled={busy} onClick={()=>{invalidate();setIds([]);setSelectedFolders([]);}}>全不选</Button>{tab==='export'&&<Button size="small" disabled={busy} onClick={()=>void run(refresh)}>刷新</Button>}</div>
      <div className="config-transfer-sessions">
        {!groupNames.length&&<div className="config-transfer-note">暂无会话，仍可迁移首选项。</div>}
        {groupNames.map(group=>{const members=sourceSessions.filter(s=>(s.groupName??'')===group),count=members.filter(s=>ids.includes(s.id)).length;const checked=count===members.length&&(group?selectedFolders.includes(group):members.length>0);return <div key={group}>
          <div className="config-transfer-group"><Checkbox size="medium" disabled={busy} label={`${group||'未分组'} · ${members.length}`} checked={checked?true:count>0?'mixed':false} onChange={(_,d)=>selectGroup(group,d.checked===true)}/></div>
          {members.map(s=><div className="config-transfer-session" key={s.id}><Checkbox disabled={busy} label={s.name} checked={ids.includes(s.id)} onChange={(_,d)=>{invalidate();setIds(previous=>d.checked?[...previous,s.id]:previous.filter(id=>id!==s.id));}}/><span>{s.engine}</span><span className="config-transfer-path" title={s.filePath??s.host??''}>{s.filePath??s.host}</span><span>{s.readOnly?'只读':'读写'}{s.allowedDatabases?' · 限定数据库':''}</span></div>)}
        </div>;})}
      </div>
      <div className="config-transfer-toolbar">{categories.map(([key,label])=><Checkbox key={key} label={label} disabled={busy} checked={choices[key]} onChange={(_,d)=>{invalidate();setChoices(previous=>({...previous,[key]:d.checked===true}));}}/>)}</div>
      <p className="config-transfer-note">关联方案仅包含所选会话。SQL、筛选值和分析参数按原文保存，分享前请检查业务敏感内容。会话环境标记和对象收藏随会话迁移。</p>
      {tab==='export'?<div><Button size="small" appearance="primary" disabled={busy} onClick={()=>void run(async()=>{const path=await save({defaultPath:`DBFolio-config-${new Date().toISOString().slice(0,10)}.json`,filters:fileFilters});if(!path)return;await invoke('config_export',{path,options:{sessionIds:ids,folders:selectedFolders,...choices}});setMessage(`配置已导出：${path}`);})}>导出所选配置…</Button></div>:<>
        <div className="config-transfer-toolbar" style={{alignItems:'end'}}><Field label="重复处理"><Select size="small" disabled={busy} value={mode} onChange={e=>{invalidate();setMode(e.target.value as Mode);}}><option value="copy">新建副本（自动重命名）</option><option value="merge">合并（保留本机已有项）</option><option value="skip">跳过重复会话及其方案</option></Select></Field><Button size="small" disabled={busy} onClick={()=>void run(async()=>{setPreview(null);setPreview(await invoke<Preview>('config_preview',{bundle:chosen(),options:options()}));})}>预览导入</Button></div>
        <p className="config-transfer-note">重复会话按原 ID 或同分组、同引擎、同名判断。合并要求连接目标一致；不会覆盖本机密码、只读限制和数据库范围。勾选首选项会覆盖对应本机设置。</p>
        {preview&&<>
          <div className="config-transfer-preview"><table><thead><tr><th>会话</th><th>引擎</th><th>处理</th><th>导入后名称</th></tr></thead><tbody>{preview.sessions.map((s,i)=><tr key={i}><td>{s.name}</td><td>{s.engine}</td><td>{s.action}</td><td>{s.targetName}</td></tr>)}</tbody></table></div>
          <div className="config-transfer-toolbar">{Object.entries(preview.added).map(([name,count])=><span key={name}>{name}：新增 {count} / 跳过 {preview.skipped[name]??0}</span>)}<span>新增分组 {preview.folders}</span><span>首选项 {preview.preferences}</span></div>
          {preview.warnings.map(w=><div className="config-transfer-note" key={w}>{w}</div>)}
          {blocked&&<div role="status">导入前请关闭工作标签页、结束任务并断开所有会话，避免刷新界面影响当前工作。</div>}
          <div><Button size="small" appearance="primary" disabled={busy||blocked} onClick={()=>setConfirm(true)}>确认导入…</Button></div>
        </>}
      </>}
    </>}
    <Dialog open={confirm} onOpenChange={(_,d)=>{if(!busy)setConfirm(d.open);}}><DialogSurface><DialogBody><DialogTitle>{applying?'正在导入配置':'导入所选配置？'}</DialogTitle><DialogContent>{applying?<Spinner label="正在保存配置，请稍候"/>:'将按预览结果保存配置，成功后自动刷新界面。导入不会连接数据库或执行 SQL。'}</DialogContent><DialogActions><Button size="small" disabled={busy} onClick={()=>setConfirm(false)}>取消</Button><Button size="small" appearance="primary" disabled={busy||blocked} onClick={()=>void run(apply)}>导入并刷新界面</Button></DialogActions></DialogBody></DialogSurface></Dialog>
  </section>;
}
