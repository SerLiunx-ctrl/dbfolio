import {useEffect,useState} from 'react';
import {Button,Checkbox,Dropdown,Field,Input,Option,tokens} from '@fluentui/react-components';
import {revealItemInDir} from '@tauri-apps/plugin-opener';
import {TaskActivity} from '../../app/TaskActivity';
import {errorText} from '../../stores/useTaskStore';
import {checkUpdate,downloadUpdate,installUpdate,loadUpdateStatus,saveUpdatePreferences,useUpdateStore} from './updateStore';

export function UpdatePanel(){
  const {status,available,busy,error,message}=useUpdateStore();
  const [proxy,setProxy]=useState('');const [settingsError,setSettingsError]=useState('');const [saving,setSaving]=useState(false);
  useEffect(()=>{void loadUpdateStatus().catch(e=>setSettingsError(errorText(e)));},[]);
  useEffect(()=>{if(status)setProxy(status.preferences.proxy);},[status?.preferences.proxy]);
  const save=async(patch:Partial<NonNullable<typeof status>['preferences']>)=>{
    if(!status)return;setSaving(true);setSettingsError('');
    try{await saveUpdatePreferences({...status.preferences,...patch});}catch(e){setSettingsError(errorText(e));}finally{setSaving(false);}
  };
  return <section style={{display:'flex',flexDirection:'column',gap:8,maxWidth:660}} aria-label="软件更新">
    <div>当前版本：{status?.version??'读取中'} · {status?.distribution==='portable'?'便携版':status?.distribution==='installed'?'安装版':'开发模式'}</div>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <Checkbox size="medium" checked={status?.preferences.automatic??false} disabled={!status||!!busy||saving} label="自动检查更新（每天一次）" onChange={(_,d)=>void save({automatic:!!d.checked})}/>
      <Dropdown size="small" aria-label="更新通道" value={status?.preferences.channel==='stable'?'稳定版':'预览版'} selectedOptions={[status?.preferences.channel??'preview']} disabled={!status||!!busy||saving} onOptionSelect={(_,d)=>void save({channel:d.optionValue as 'stable'|'preview',skipped:''})}>
        <Option value="stable">稳定版</Option><Option value="preview">预览版（alpha / beta）</Option>
      </Dropdown>
    </div>
    <Field label="更新代理（可选，不含认证；留空使用默认网络）">
      <div style={{display:'flex',gap:6}}><Input size="small" style={{flex:1}} value={proxy} placeholder="http://127.0.0.1:7897" disabled={!!busy||saving} onChange={(_,d)=>setProxy(d.value)}/><Button size="small" disabled={!status||!!busy||saving||proxy===status.preferences.proxy} onClick={()=>void save({proxy})}>保存</Button></div>
    </Field>
    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      <Button size="small" disabled={!!busy||saving} onClick={()=>void checkUpdate()}>{busy==='check'?'正在检查…':'检查更新'}</Button>
      {available&&status?.readyVersion!==available.version&&<Button size="small" appearance="primary" disabled={!!busy||saving} onClick={()=>void downloadUpdate()}>下载 {available.version}</Button>}
      {status?.readyVersion&&<Button size="small" appearance="primary" disabled={!!busy||saving} onClick={()=>void installUpdate()}>重启并更新至 {status.readyVersion}</Button>}
      {available&&<Button size="small" disabled={!!busy||saving} onClick={()=>void save({skipped:available.skipped?'':available.version})}>{available.skipped?'恢复此版本提醒':'跳过此版本提醒'}</Button>}
      {status&&<Button size="small" disabled={!!busy} onClick={()=>void revealItemInDir(status.logPath).catch(e=>setSettingsError(String(e)))}>查看更新缓存与恢复材料</Button>}
    </div>
    {available&&<div><strong>新版本 {available.version}</strong>{available.size?<span> · {(available.size/1048576).toFixed(1)} MiB</span>:null}<div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:220,overflowY:'auto',marginTop:6}}>{available.notes||'此版本未提供更新说明。'}</div></div>}
    {(message||error||settingsError)&&<div role={error||settingsError?'alert':'status'} style={{color:error||settingsError?tokens.colorPaletteRedForeground1:undefined,overflowWrap:'anywhere'}}>{settingsError||error||message}</div>}
    <TaskActivity kind="更新"/>
    <small style={{color:tokens.colorNeutralForeground3,lineHeight:'18px'}}>下载完成后由你决定安装时间。安装前需处理未保存修改、手动事务及运行任务。程序与 web 资源整体更新，会话和数据库文件保留。</small>
    {status?.preferences.lastCheck? <small>上次检查：{new Date(status.preferences.lastCheck*1000).toLocaleString('zh-CN')}</small>:null}
  </section>;
}
