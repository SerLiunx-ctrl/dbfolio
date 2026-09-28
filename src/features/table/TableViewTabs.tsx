import {Badge,Tab,TabList} from '@fluentui/react-components';
import {InfoRegular,GridRegular,ColumnTripleRegular,ArrowSortRegular,LinkRegular,CodeRegular} from '@fluentui/react-icons';
import type {TableView} from '../../stores/useTabStore';
export function TableViewTabs({view,onSelect,counts,creating=false}:{view:TableView;onSelect:(view:TableView)=>void;counts?:{columns:number;indexes:number;foreignKeys:number};creating?:boolean}){
 const count=(key:'columns'|'indexes'|'foreignKeys')=>counts&&<Badge size="small" appearance="tint">{counts[key]}</Badge>;
 return <TabList size="small" selectedValue={view} onTabSelect={(_,d)=>onSelect(d.value as TableView)} style={{padding:'0 12px'}}>
  <Tab value="info" icon={<InfoRegular/>}>信息</Tab>{!creating&&<Tab value="data" icon={<GridRegular/>}>数据</Tab>}
  <Tab value="structure" icon={<ColumnTripleRegular/>}>结构 {count('columns')}</Tab><Tab value="indexes" icon={<ArrowSortRegular/>}>索引 {count('indexes')}</Tab><Tab value="foreignKeys" icon={<LinkRegular/>}>外键 {count('foreignKeys')}</Tab><Tab value="ddl" icon={<CodeRegular/>}>DDL</Tab>
 </TabList>;
}
