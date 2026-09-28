import {useState} from 'react';
import {Button,Checkbox,Field,Input,Select,Switch,tokens} from '@fluentui/react-components';
import {open} from '@tauri-apps/plugin-dialog';
import {api} from '../../ipc';
import type {Engine,NetworkConfig,SshConfig} from '../../ipc/types';

export function ConnectionSecurity({engine,value,onChange,sshPassword,onPassword,sshPassphrase,onPassphrase,disabled=false}:{engine:Engine;value:NetworkConfig;onChange:(v:NetworkConfig)=>void;sshPassword:string|null;onPassword:(v:string|null)=>void;sshPassphrase:string|null;onPassphrase:(v:string|null)=>void;disabled?:boolean}){
 const [observed,setObserved]=useState<{target:string;value:string}|null>(null),[error,setError]=useState(''),[probing,setProbing]=useState(false);
 const set=(patch:Partial<NetworkConfig>)=>onChange({...value,...patch});
 const ssh=value.ssh,patchSsh=(patch:Partial<SshConfig>)=>{if(ssh)set({ssh:{...ssh,...patch}});};
 const target=ssh?`${ssh.host}:${ssh.port}`:'';
 const path=(label:string,key:'caFile'|'clientCert'|'clientKey')=><Field label={label}><div style={{display:'flex',gap:4}}><Input size="small" aria-label={label} style={{flex:1,minWidth:0}} value={value[key]??''} onChange={(_,d)=>set({[key]:d.value||null})}/><Button size="small" onClick={async()=>{const p=await open({multiple:false,directory:false});if(typeof p==='string')set({[key]:p});}}>浏览</Button></div></Field>;
 return <details style={{gridColumn:'1 / -1'}}><summary style={{cursor:'pointer',fontSize:12}}>连接安全与超时</summary><fieldset disabled={disabled} style={{border:0,padding:'8px 0 0',margin:0,display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:12}}>
  <Field label="连接超时（秒）"><Input size="small" type="number" min={1} max={120} value={String(value.connectTimeoutSecs??15)} onChange={(_,d)=>set({connectTimeoutSecs:Number(d.value)})}/></Field>
  <Field label="查询超时（秒）"><Input size="small" type="number" min={1} max={3600} value={String(value.queryTimeoutSecs??60)} onChange={(_,d)=>set({queryTimeoutSecs:Number(d.value)})}/></Field>
  {engine!=='sqlite'&&<>
   {path('CA 证书（PEM，可选）','caFile')}{path('客户端证书（PEM，可选）','clientCert')}{path('客户端私钥（PEM）','clientKey')}
   <Field label="TLS 服务器名（默认数据库地址）"><Input size="small" value={value.serverName??''} onChange={(_,d)=>set({serverName:d.value||null})}/></Field>
   {engine==='mongodb'&&<div style={{gridColumn:'1/-1',color:tokens.colorNeutralForeground3}}>URI/SRV 仅直连；URI 客户端认证请在证书项选择含私钥的 PEM，私钥项留空。SSH 请填单个主机地址。</div>}
   <Switch style={{gridColumn:'1/-1'}} label="通过 SSH 隧道连接" checked={!!ssh} onChange={(_,d)=>{setObserved(null);set({ssh:d.checked?{host:'',port:22,username:'',auth:'password',fingerprint:''}:null});}}/>
   {ssh&&<>
    <Field label="SSH 主机"><Input size="small" value={ssh.host} onChange={(_,d)=>patchSsh({host:d.value,fingerprint:''})}/></Field>
    <Field label="SSH 端口"><Input size="small" type="number" min={1} max={65535} value={String(ssh.port)} onChange={(_,d)=>patchSsh({port:Number(d.value),fingerprint:''})}/></Field>
    <Field label="SSH 用户名"><Input size="small" value={ssh.username} onChange={(_,d)=>patchSsh({username:d.value})}/></Field>
    <Field label="SSH 认证"><Select size="small" value={ssh.auth} onChange={(_,d)=>patchSsh({auth:d.value as SshConfig['auth']})}><option value="password">密码</option><option value="key">私钥</option></Select></Field>
    {ssh.auth==='key'&&<Field label="SSH 私钥文件" style={{gridColumn:'1/-1'}}><div style={{display:'flex',gap:4}}><Input size="small" style={{flex:1}} value={ssh.privateKey??''} onChange={(_,d)=>patchSsh({privateKey:d.value})}/><Button size="small" onClick={async()=>{const p=await open({multiple:false});if(typeof p==='string')patchSsh({privateKey:p});}}>浏览</Button></div></Field>}
    <Field label={ssh.auth==='key'?'私钥口令':'SSH 密码'}><Input size="small" type="password" autoComplete="new-password" value={(ssh.auth==='key'?sshPassphrase:sshPassword)??''} placeholder="留空保留已保存凭据" onChange={(_,d)=>(ssh.auth==='key'?onPassphrase:onPassword)(d.value||null)}/></Field>
    <Checkbox label="清除已保存的此项凭据" checked={(ssh.auth==='key'?sshPassphrase:sshPassword)===''} onChange={(_,d)=>(ssh.auth==='key'?onPassphrase:onPassword)(d.checked?'':null)}/>
    <Field label="已信任的主机指纹（SHA256）" style={{gridColumn:'1/-1'}}><Input size="small" value={ssh.fingerprint} onChange={(_,d)=>patchSsh({fingerprint:d.value.trim()})}/></Field>
    <div style={{gridColumn:'1/-1',display:'flex',gap:6}}><Button size="small" disabled={probing||!ssh.host||!ssh.port} onClick={async()=>{setProbing(true);setError('');setObserved(null);try{setObserved({target,value:await api.sshFingerprint(ssh,value.connectTimeoutSecs??15)});}catch(e){setError(String((e as {message?:string}).message??e));}finally{setProbing(false);}}}>{probing?'获取中…':'获取服务器指纹'}</Button>{observed?.target===target&&<Button size="small" onClick={()=>patchSsh({fingerprint:observed.value})}>已核对，信任此指纹</Button>}</div>
    {observed?.target===target&&<div style={{gridColumn:'1/-1',overflowWrap:'anywhere'}}>待核对：{observed.value}<br/>请与服务器管理员提供的指纹核对；获取指纹不会自动信任。</div>}
    {error&&<div role="alert" style={{gridColumn:'1/-1',color:tokens.colorPaletteRedForeground1}}>{error}</div>}
   </>}
  </>}
 </fieldset></details>;
}
