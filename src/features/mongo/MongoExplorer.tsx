import {InfoHint} from '../../common/InfoHint';
import {Button,Input,Spinner,tokens} from '@fluentui/react-components';
import {ArrowClockwiseRegular,DatabaseRegular,DocumentRegular} from '@fluentui/react-icons';
import {useEffect,useState} from 'react';
import {DockTitle} from '../../app/DockLayout';
import {ConnectionNotice} from '../../app/ConnectionNotice';
import {useNotify} from '../../app/toast';
import {api} from '../../ipc';
import type {SessionRecord} from '../../ipc/types';
import {useSessionStore} from '../../stores/useSessionStore';
import {useTabStore} from '../../stores/useTabStore';
import {useObjectPreferences} from '../../stores/useObjectPreferences';
import {FavoriteButton} from '../explorer/FavoriteButton';
import {mongo} from './api';
export function MongoExplorer({session}:{session:SessionRecord}){
 const notify=useNotify(), connected=useSessionStore(s=>s.statuses[session.id]);
 const [databases,setDatabases]=useState<string[]>([]),[database,setDatabase]=useState(session.database??''),[collections,setCollections]=useState<string[]>([]),[search,setSearch]=useState(''),[version,setVersion]=useState(0),[loading,setLoading]=useState(false),[manualName,setManualName]=useState('');
 const favorites=useObjectPreferences(s=>s.favorites).filter(f=>f.sessionId===session.id&&f.kind==='mongo');
 useEffect(()=>{if(!connected)return;let active=true;api.listDatabases(session.id).then(ds=>{if(active){setDatabases(ds.map(d=>d.name));setDatabase(old=>old||ds[0]?.name||'');}}).catch(e=>{if(active)notify.error(e);});return()=>{active=false;};},[session.id,connected,version,notify]);
 useEffect(()=>{setCollections([]);if(!connected||!database)return;let active=true;setLoading(true);mongo.collections(session.id,database).then(ds=>{if(active)setCollections(ds.sort());}).catch(e=>{if(active)notify.error(e);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[session.id,database,connected,version,notify]);
 const open=(db:string,name:string)=>useTabStore.getState().openMongo(session.id,db,name);
 return <section className="dw-mongo-explorer"><header><DockTitle panel="explorer">对象浏览器</DockTitle><Button size="small" appearance="subtle" icon={<ArrowClockwiseRegular/>} aria-label="刷新集合" onClick={()=>setVersion(v=>v+1)} disabled={!connected}/></header>
 {!connected?<ConnectionNotice sessionId={session.id} standalone/>:<>
 <div style={{padding:8,display:'grid',gap:8}}><label><DatabaseRegular/> 数据库<select className="dw-native-select" style={{width:'100%'}} value={database} onChange={e=>setDatabase(e.target.value)}>{databases.map(d=><option key={d}>{d}</option>)}</select></label><Input placeholder="搜索集合" value={search} onChange={(_,d)=>setSearch(d.value)}/></div>
 <div style={{display:"flex",padding:8,gap:6}}><Input aria-label="集合名称" placeholder="输入集合名" value={manualName} onChange={(_,d)=>setManualName(d.value)} style={{minWidth:0,flex:1}}/><Button disabled={!database||!manualName.trim()} onClick={()=>open(database,manualName.trim())}>打开</Button></div><InfoHint label="打开集合说明">可按名称打开集合；新集合在首次保存文档后创建。</InfoHint>
 <div style={{flex:1,minHeight:0,overflow:'auto'}}>{favorites.length>0&&<details><summary>收藏（{favorites.length}）</summary>{favorites.map(f=><div className="dw-mongo-object" key={f.database+'/'+f.name}><Button appearance="subtle" onClick={()=>open(f.database,f.name)}>{f.database}.{f.name}</Button><FavoriteButton item={f}/></div>)}</details>}
 {loading?<Spinner size="tiny" label="读取集合"/>:collections.filter(c=>c.toLowerCase().includes(search.toLowerCase())).map(c=><div className="dw-mongo-object" key={c}><Button appearance="subtle" icon={<DocumentRegular/>} style={{flex:1,minWidth:0,justifyContent:'start',overflow:'hidden'}} title={c} onClick={()=>open(database,c)}>{c}</Button><FavoriteButton item={{kind:'mongo',sessionId:session.id,database,name:c}}/></div>)}
 {!loading&&!collections.length&&<p style={{padding:12,color:tokens.colorNeutralForeground3}}>当前数据库没有可见集合</p>}
 </div></>}
 </section>;
}
