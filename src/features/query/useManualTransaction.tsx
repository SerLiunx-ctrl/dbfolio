import {useEffect,useRef,useState} from 'react';
import {Button,Spinner,tokens} from '@fluentui/react-components';
import {api,normalizeError,type TransactionInfo} from '../../ipc';
import type {QueryOutcome,SortSpec} from '../../ipc/types';
import {usePendingEdit} from '../../stores/useEditGuard';
import {InfoHint} from '../../common/InfoHint';

export function useManualTransaction(tabId:string,sessionId:string,database:string,isRunning:()=>boolean){
  const [transaction,setTransaction]=useState<TransactionInfo|null>(null),[busy,setBusy]=useState(false),[lost,setLost]=useState(false),[message,setMessage]=useState('');
  const alive=useRef(true);
  const current=useRef<TransactionInfo|null>(null),lock=useRef(false),statements=useRef<string[]>([]),running=useRef(isRunning);running.current=isRunning;
  const finish=async(commit:boolean)=>{
    if(lock.current||running.current())throw Error('请等待当前语句结束');
    const tx=current.current;if(!tx)return;
    lock.current=true;setBusy(true);
    try{
      await api.transactionFinish(tx.id,sessionId,commit);
      current.current=null;setTransaction(null);setLost(false);statements.current=[];
      setMessage(commit?'事务已提交':lost?'已结束事务模式，请核对上一次操作结果':'事务已回滚');
    }catch(e){setMessage(normalizeError(e).message);setLost(true);throw e;}
    finally{lock.current=false;setBusy(false);}
  };
  usePendingEdit({tabId,sessionId,kind:'transaction',label:database+'（未结束的手动事务）',busy:()=>lock.current||running.current(),
    save:()=>finish(true),discard:()=>finish(false),preview:async()=>statements.current.length?statements.current:['尚未执行语句；事务连接仍占用中']},!!transaction||busy,tabId+':transaction');
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;const tx=current.current;if(tx)void api.transactionFinish(tx.id,sessionId,false).catch(()=>{});};},[sessionId]);
  useEffect(()=>{if(!transaction)return;let live=true,polling=false;
    const timer=setInterval(()=>{if(lock.current||running.current()||polling)return;polling=true;void api.transactionStatus(transaction.id).then(status=>{if(live&&!status){setLost(true);setMessage('事务已结束或连接已断开。请结束事务模式后重新查询，当前结果为旧快照。');}}).catch(()=>{}).finally(()=>{polling=false;});},2500);
    return()=>{live=false;clearInterval(timer);};
  },[transaction?.id]);
  const begin=async()=>{if(lock.current||running.current())return;lock.current=true;setBusy(true);setMessage('');try{const tx=await api.transactionBegin(sessionId,database,tabId);if(!alive.current){await api.transactionFinish(tx.id,sessionId,false);return;}current.current=tx;setTransaction(tx);setLost(false);statements.current=[];}catch(e){setMessage(normalizeError(e).message);}finally{lock.current=false;setBusy(false);}};
  const execute=async(sql:string,force:boolean,offset=0,sort:SortSpec[]=[],limit=200):Promise<QueryOutcome>=>{
    const tx=current.current;if(!tx||lost)throw Error('事务已失效，请先结束事务模式');
    if(lock.current)throw Error('事务操作进行中');
    try{const result=await api.transactionExecute(tx.id,sessionId,sql,force,offset,sort,limit);const next={...tx,statements:tx.statements+1};current.current=next;setTransaction(next);if(!offset)statements.current=[...statements.current,sql].slice(-100);return result;}
    catch(e){try{const status=await api.transactionStatus(tx.id);if(!status){setLost(true);setMessage(normalizeError(e).message);}}catch{setLost(true);setMessage('无法确认事务状态，请结束事务模式并核对数据库。');}throw e;}
  };
  return {transaction,busy,lost,message,begin,finish,execute};
}
export function TransactionControls({state,disabled,readOnly}:{state:ReturnType<typeof useManualTransaction>;disabled:boolean;readOnly:boolean}){
  return <><span style={{display:'inline-flex',alignItems:'center',gap:6}}>{state.busy&&<Spinner size="tiny"/>}
    {!state.transaction?<Button size="small" disabled={disabled||readOnly||state.busy} onClick={()=>void state.begin()}>开启事务</Button>:<>
      <strong style={{fontSize:12,color:state.lost?tokens.colorPaletteRedForeground1:tokens.colorPaletteMarigoldForeground1}}>{state.lost?'事务已失效':'事务中 · '+state.transaction.statements+' 条'}</strong>
      <Button size="small" disabled={disabled||state.busy||state.lost} onClick={()=>void state.finish(true).catch(()=>{})}>提交事务</Button>
      <Button size="small" disabled={disabled||state.busy} onClick={()=>void state.finish(false).catch(()=>{})}>{state.lost?'结束事务模式':'回滚事务'}</Button>
    </>}
    <InfoHint label="手动事务说明">当前查询页独占事务连接，只有提交后修改才持久化。DDL 和管理语句不在手动事务中执行。MySQL 只支持不带触发器的单表 InnoDB 写入；存储函数的外部副作用不保证可回滚。发生执行错误或取消时回滚整个事务。其他页面读取不到尚未提交的数据。</InfoHint>
  </span>{state.message&&<span role="status" style={{fontSize:12,color:state.lost?tokens.colorPaletteRedForeground1:tokens.colorNeutralForeground3}}>{state.message}</span>}</>;
}
