import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,FluentProvider} from '@fluentui/react-components';
import {ForeignKeyDialog} from '../../src/features/table/ForeignKeyDialog';
import {IndexesPanel} from '../../src/features/table/StructurePanel';
import {generateDdl} from '../../src/features/table/ddl';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {AppToaster} from '../../src/app/toast';
import {buildTheme} from '../../src/theme';
import type {Engine,TableMeta} from '../../src/ipc/types';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,params=new URLSearchParams(location.search),engine=(params.get('engine')??'postgres') as Engine,mode=params.has('oled')?'oled':'aurora';
const column=(name:string)=>({name,rawType:'integer',ordinal:1,nullable:true,unsigned:false,autoIncrement:false,canonical:{kind:'int',bits:32,unsigned:false}} as const);
const columns=[column('id'),column('pid')];
const original='CREATE INDEX idx_partial ON sales.child USING btree (pid DESC) INCLUDE (id) WHERE pid > 0';
const detail:TableMeta={name:'child',schema:'sales',kind:'table',columns,primaryKey:[],indexes:[{name:'idx_normal',columns:[{name:'pid',desc:false}],primary:false,unique:false,method:'btree'},{name:'idx_partial',columns:[{name:'pid',desc:true}],primary:false,unique:false,method:'btree',definition:original,editUnsupportedReason:'包含条件和 INCLUDE，请通过 SQL 管理'}],foreignKeys:[{name:'fk_parent',columns:['pid'],refSchema:'qa.dot',refTable:'parent',refColumns:['id'],onDelete:'CASCADE',onUpdate:'NO ACTION'}]};
useSessionStore.setState({sessions:[{id:'s',engine,name:'隔离测试',readOnly:false} as any]});
w.calls=[];w.ddl=()=>generateDdl(engine,detail);
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='meta_tables')return engine==='postgres'?[{name:'parent',schema:'sales',kind:'table'},{name:'parent',schema:'public',kind:'table'}]:[{name:'parent',kind:'table'}];
 if(command==='meta_table_detail'){const name=args.schema==='public'?'public_id':'id';await new Promise(r=>setTimeout(r,args.schema==='public'?30:150));return {columns:[column(name)]};}
 if(command==='ddl_preview')return ['-- 隔离预览'];
 if(command==='ddl_apply')return [];
 if(command==='settings_get')return null;
 if(command==='clipboard_write_text')return null;
 throw Error(command);
}};
function Demo(){const [open,setOpen]=useState(false);return <FluentProvider theme={buildTheme(params.has('oled'),'#0f6cbd',mode)}><AppToaster/><Button onClick={()=>setOpen(true)}>编辑已有外键</Button><IndexesPanel tab={{id:'t',kind:'table',sessionId:'s',database:'test',schema:'sales',table:'child',title:'child',view:'indexes'}} detail={detail} engine={engine} readOnly={false} onChanged={()=>{}}/><ForeignKeyDialog open={open} sessionId="s" database="test" schema={engine==='postgres'?'sales':null} table="child" columns={columns} initial={{name:'fk_parent',columns:['pid'],refTable:'parent',refSchema:engine==='postgres'?'sales':null,refColumns:['id'],onDelete:'CASCADE',onUpdate:'NO ACTION'}} onClose={()=>setOpen(false)} onDone={()=>{}}/></FluentProvider>;}
createRoot(document.getElementById('root')!).render(<Demo/>);
