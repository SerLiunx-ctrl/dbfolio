import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme,Button} from '@fluentui/react-components';
import {IndexesPanel,ForeignKeysPanel} from '../../src/features/table/StructurePanel';
import {SessionDialog} from '../../src/features/sessions/SessionDialog';
import {AppToaster} from '../../src/app/toast';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useExplorerStore} from '../../src/stores/useExplorerStore';
import '../../src/styles.css';
const w=window as any;w.calls=[];
const session:any={id:'s',name:'MySQL 测试',engine:'mysql',host:'127.0.0.1',port:3306,username:'root',database:'',readOnly:false,hasPassword:false,createdAt:'',updatedAt:''};
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='meta_databases')return [{name:'test_db'},{name:'prod'}];
 if(command==='session_update')return {...session,...args.input};
 if(command==='settings_get')return null;
 if(command==='settings_set')return;
 throw Error(command);
}};
useSessionStore.setState({sessions:[session],statuses:{s:{sessionId:'s',connected:true}},activeSessionId:'s'});
useExplorerStore.setState({databases:{s:[{name:'test_db'},{name:'prod'}]}});w.explorer=useExplorerStore;w.sessions=useSessionStore;
function Demo(){const [count,setCount]=useState(0),[ro,setRo]=useState(false),[open,setOpen]=useState(false);const record=useSessionStore(s=>s.sessions[0]);
 const detail:any={name:'t',kind:'table',columns:[],indexes:Array.from({length:count},(_,i)=>({name:'idx'+i,columns:[{name:'id'}]})),foreignKeys:Array.from({length:count},(_,i)=>({name:'fk'+i,columns:['id'],refTable:'other',refColumns:['id'],onDelete:'NO ACTION',onUpdate:'NO ACTION'}))};
 const props:any={tab:{id:'t',kind:'table',sessionId:'s',database:'test_db',table:'t'},detail,engine:'mysql',readOnly:ro,onChanged:()=>{}};
 return <><nav><Button onClick={()=>setCount(0)}>空列表</Button><Button onClick={()=>setCount(1)}>单条</Button><Button onClick={()=>setCount(3)}>多条</Button><Button onClick={()=>setRo(v=>!v)}>切换只读</Button><Button onClick={()=>setOpen(true)}>会话设置</Button></nav><div data-testid="indices" style={{display:'flex',height:250}}><IndexesPanel {...props}/></div><div data-testid="foreign" style={{display:'flex',height:250}}><ForeignKeysPanel {...props}/></div><SessionDialog open={open} session={record} folders={[]} onClose={()=>setOpen(false)} onSaved={()=>{}}/><AppToaster/></>;
}
createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><Demo/></FluentProvider>);
