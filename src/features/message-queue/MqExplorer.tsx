import {useState} from 'react';
import {Button,Input,Select,Spinner,Checkbox} from '@fluentui/react-components';
import {ArrowClockwiseRegular,MailRegular} from '@fluentui/react-icons';
import {DockTitle} from '../../app/DockLayout';
import {ConnectionNotice} from '../../app/ConnectionNotice';
import {useSessionStore} from '../../stores/useSessionStore';
import {useTabStore} from '../../stores/useTabStore';
import {useCatalog} from './useCatalog';import {objectKey,systemObject} from './model';
import './message-queue.css';
export function MqExplorer({sessionId}:{sessionId:string}){
 const connected=useSessionStore(s=>Boolean(s.statuses[sessionId])),session=useSessionStore(s=>s.sessions.find(v=>v.id===sessionId));const active=useTabStore(s=>s.tabs.find(t=>t.id===s.activeId));
 const [scope,setScope]=useState<string|undefined>(session?.database||undefined),[search,setSearch]=useState(''),[showSystem,setSystem]=useState(false);
 const {catalog,loading,error,refresh}=useCatalog(sessionId,scope,connected);
 const objects=catalog?.objects.filter(o=>(showSystem||!systemObject(o.name))&&o.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))??[];
 const open=useTabStore(s=>s.openMessageQueue);
 return <aside className="mq-explorer"><div className="mq-title"><DockTitle panel="explorer">对象浏览器</DockTitle><Button size="small" appearance="subtle" aria-label="刷新消息对象" title="刷新消息对象" icon={<ArrowClockwiseRegular/>} disabled={!connected||loading} onClick={()=>void refresh()}/></div>
 {!connected?<ConnectionNotice sessionId={sessionId} standalone/>:<><label className="mq-small-label">{session?.engine==='rabbitmq'?'VHost':'消息系统'}<Select size="small" aria-label="消息系统命名空间" value={scope??catalog?.scope??''} onChange={(_,d)=>setScope(d.value)} disabled={loading}>{catalog?.scopes.map(s=><option key={s} value={s}>{s==='cluster'?'集群':s}</option>)}</Select></label>
 <div className="mq-search"><Input size="small" aria-label="搜索消息对象" placeholder="搜索 Topic / 队列 / 交换机" value={search} onChange={(_,d)=>setSearch(d.value)}/><Checkbox size="medium" label="系统对象" checked={showSystem} onChange={(_,d)=>setSystem(d.checked===true)}/></div>
 {loading&&<Spinner size="tiny" label="刷新目录…"/>}{error&&<div role="alert" className="mq-error">{error}</div>}
 {catalog&&<><Button size="small" appearance="subtle" className="mq-overview" icon={<MailRegular/>} onClick={()=>open(sessionId,catalog.scope)}>消息概览 · {catalog.objects.length}{catalog.limited?'+':''} 个对象</Button><div className="mq-tree" role="navigation" aria-label="消息对象列表">{['topic','queue','exchange'].map(kind=>{const items=objects.filter(o=>o.kind===kind);return items.length>0&&<section key={kind}><div className="mq-group">{kind==='topic'?'Topic':kind==='queue'?'队列':'交换机'} <span>{items.length}</span></div>{items.slice(0,500).map(o=><button key={objectKey(o)} className={'mq-object'+(active?.kind==='messageQueue'&&active.sessionId===sessionId&&active.database===catalog.scope&&active.name===o.name&&active.objectKind===o.kind?' selected':'')} title={o.name} onClick={()=>open(sessionId,catalog.scope,o.name,o.kind)}><MailRegular/><span>{o.name}</span><small>{o.count??(o.partitions.length?`${o.partitions.length} 分区`:'')}</small></button>)}{items.length>500&&<small>当前类别显示前 500 项，请输入名称搜索。</small>}</section>;})}{!objects.length&&!loading&&<div className="mq-empty">没有匹配的对象</div>}</div>{catalog.limited&&<small>目录达到 5000 项上限，当前为部分列表。</small>}</>}
 </>}
 </aside>;
}
