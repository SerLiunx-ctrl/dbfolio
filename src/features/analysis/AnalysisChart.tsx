import {useMotionPreference} from "../../useMotionPreference";
import {InfoHint} from '../../common/InfoHint';
import {useEffect,useRef,useImperativeHandle,useState,type Ref} from 'react';
import * as echarts from 'echarts/core';
import {BarChart,LineChart,PieChart,ScatterChart} from 'echarts/charts';
import {TitleComponent,TooltipComponent,GridComponent,LegendComponent,DataZoomComponent,GraphicComponent,AriaComponent} from 'echarts/components';
import {CanvasRenderer} from 'echarts/renderers';
import {useIsDark} from '../../theme';
import {useSettingsStore} from '../../stores/useSettingsStore';
import {type ChartConfig,type ChartData} from './model';

echarts.use([BarChart,LineChart,PieChart,ScatterChart,TitleComponent,TooltipComponent,GridComponent,LegendComponent,DataZoomComponent,GraphicComponent,AriaComponent,CanvasRenderer]);
export interface ChartHandle {png:()=>Promise<string>;}
export function AnalysisChart({config,data,title,scope,ref}:{config:ChartConfig;data:ChartData;title:string;scope:string;ref?:Ref<ChartHandle>}) {
 const host=useRef<HTMLDivElement>(null),instance=useRef<echarts.ECharts|null>(null),dark=useIsDark(),accent=useSettingsStore(s=>s.resolvedAccent);
 const motion=useMotionPreference();
 const oled=useSettingsStore(s=>s.themeMode==='oled');
 const [search,setSearch]=useState('');
 const pie=config.kind==='pie'||config.kind==='donut';
 const colors=[accent,dark?'#4fc3b6':'#299f97',dark?'#f3b557':'#e29b39',dark?'#ae94e8':'#9472d1',dark?'#ed819a':'#d86281',dark?'#99c672':'#77a85a',dark?'#8eace8':'#668dd0',dark?'#d79a6c':'#b77a4b',dark?'#b9c779':'#899b48',dark?'#d691cf':'#ad72aa',dark?'#69c5d5':'#419fb1',dark?'#ed947e':'#ca725b'];
 const piePoints=data.points.filter(p=>p.value!==null);
 const max=Math.max(0,...piePoints.map(p=>p.value??0));
 const scaledTotal=max>0?piePoints.reduce((s,p)=>s+(p.value??0)/max,0):0;
 const share=(value:number|null)=>scaledTotal>0?((value??0)/max/scaledTotal*100).toFixed(1)+'%':'0.0%';
 const names=[...new Set(data.points.map(p=>p.series))];
 const items=pie?piePoints.map((p,i)=>({name:p.category,value:p.value,percent:share(p.value),index:i})):names.map((name,i)=>({name,value:null,percent:'',index:i}));
 const showLegend=pie||['bar','horizontal','line','area'].includes(config.kind)&&names.length>1;
 const total=piePoints.reduce((sum,point)=>sum+(point.value??0),0);
 const formatNumber=(value:number)=>value.toLocaleString('zh-CN',{maximumFractionDigits:2});
 useImperativeHandle(ref,()=>({png:async()=>{
  if(!instance.current)throw Error('图表尚未就绪');
  const url=instance.current.getDataURL({type:'png',pixelRatio:2});if(!showLegend)return url;
  const bitmap=new Image();bitmap.src=url;await bitmap.decode();
  // Export all legend entries, independent of the on-screen search and scroll position.
  const perColumn=50,columnWidth=580,rowHeight=52,padding=24,columns=Math.ceil(items.length/perColumn);
  const canvas=document.createElement('canvas');canvas.width=bitmap.width+columns*columnWidth;canvas.height=Math.max(bitmap.height,100+Math.min(items.length,perColumn)*rowHeight);
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('无法创建图表导出画布');ctx.fillStyle=oled?'#000000':dark?'#171b23':'#fbfcff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);
  ctx.font='24px sans-serif';ctx.fillStyle=dark?'#eee':'#333';ctx.fillText(pie?'分类明细 · 数值 · 占比':'系列',bitmap.width+padding,46);
  const shorten=(value:string,width:number)=>{if(ctx.measureText(value).width<=width)return value;let text=value;while(text.length&&ctx.measureText(text+'…').width>width)text=text.slice(0,-1);return text+'…';};
  items.forEach((item,i)=>{const x=bitmap.width+Math.floor(i/perColumn)*columnWidth+padding,y=90+(i%perColumn)*rowHeight;ctx.fillStyle=colors[item.index%colors.length];ctx.fillRect(x,y-18,18,18);ctx.fillStyle=dark?'#eee':'#333';ctx.textAlign='left';ctx.fillText(shorten(item.name,pie?260:500),x+28,y);if(pie){ctx.textAlign='right';ctx.fillText(shorten(String(item.value),120),x+420,y);ctx.fillText(item.percent,x+530,y);}});
  return canvas.toDataURL('image/png');
 }}),[data,config,dark,accent,oled]);
 useEffect(()=>setSearch(''),[config.kind,data]);
 useEffect(()=>{if(!host.current)return;const chart=echarts.init(host.current,dark?'dark':undefined);instance.current=chart;const observer=new ResizeObserver(()=>chart.resize());observer.observe(host.current);return()=>{observer.disconnect();chart.dispose();instance.current=null;};},[dark]);
 useEffect(()=>{
  const chart=instance.current;if(!chart)return;
  const categories=[...new Set(data.points.map(p=>p.category))];
  const horizontal=config.kind==='horizontal';
  const foreground=dark?'#e5e9f0':'#27364a',muted=dark?'#9aa8b9':'#67788c',rule=dark?'#343b49':'#e8edf4';
  const numberLabel=(value:number)=>formatNumber(value);
  const valueAxis={type:'value' as const,scale:true,axisLine:{show:false},axisTick:{show:false},axisLabel:{color:muted,fontSize:11,formatter:numberLabel},splitLine:{lineStyle:{color:rule,type:'dashed' as const}}};
  const option:echarts.EChartsCoreOption={backgroundColor:oled?'#000000':dark?'#171b23':'#fbfcff',color:colors,animation:motion === "full",animationDuration:300,animationDurationUpdate:220,animationEasing:'cubicOut',aria:{enabled:true},title:{text:title,subtext:scope,left:20,top:16,itemGap:5,textStyle:{fontSize:16,fontWeight:600,color:foreground},subtextStyle:{fontSize:11,color:muted,width:650,overflow:'truncate'}},tooltip:{trigger:pie||config.kind==='scatter'?'item':'axis',renderMode:'richText',confine:true,backgroundColor:oled?'#0b0b0b':dark?'#242a35':'#ffffff',borderColor:rule,borderWidth:1,textStyle:{color:foreground,fontSize:12},padding:[9,12],extraCssText:'box-shadow:0 8px 22px rgba(0,0,0,.12);border-radius:8px'},legend:{show:false},grid:{left:30,right:30,top:90,bottom:64,containLabel:true}};
  if(config.kind==='kpi'){const value=data.points[0]?.value;option.graphic=[{type:'text',left:'center',top:'40%',style:{text:value==null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:6}),fill:accent,fontSize:52,fontWeight:650}},{type:'text',left:'center',top:'62%',style:{text:'当前数据范围 · '+({sum:'合计',count:'记录数',avg:'平均值',min:'最小值',max:'最大值'}[config.aggregate]),fill:muted,fontSize:13}}];}
  else if(pie){
   const labelsVisible=piePoints.length<=5;
   option.tooltip={trigger:'item',renderMode:'richText',confine:true,backgroundColor:oled?'#0b0b0b':dark?'#242a35':'#ffffff',borderColor:rule,borderWidth:1,textStyle:{color:foreground,fontSize:12},padding:[9,12],formatter:(p:any)=>`${p.name}\n数值：${formatNumber(Number(p.value))}\n占比：${share(Number(p.value))}`};
   option.series=[{type:'pie',stillShowZeroSum:false,radius:config.kind==='donut'?['42%',labelsVisible?'65%':'74%']:labelsVisible?'62%':'72%',center:['50%','56%'],minAngle:2,selectedMode:'single',avoidLabelOverlap:true,padAngle:piePoints.length>1?1.2:0,itemStyle:{borderColor:oled?'#000000':dark?'#171b23':'#fbfcff',borderWidth:2,borderRadius:4},emphasis:{scale:true,scaleSize:6,itemStyle:{shadowBlur:18,shadowColor:'rgba(0,0,0,.20)'}},label:{show:labelsVisible,color:foreground,fontSize:11,lineHeight:16,formatter:(p:any)=>`${p.name}\n${share(Number(p.value))}`,overflow:'truncate',width:110},labelLine:{show:labelsVisible,length:13,length2:10,lineStyle:{width:1.2}},labelLayout:{hideOverlap:true},data:piePoints.map(p=>({name:p.category,value:p.value}))}];
   if(config.kind==='donut')option.graphic=[{type:'text',left:'center',top:'49%',style:{text:formatNumber(total),fill:foreground,fontSize:28,fontWeight:650,textAlign:'center'}},{type:'text',left:'center',top:'59%',style:{text:'当前展示合计',fill:muted,fontSize:11,textAlign:'center'}}];
  }
  else if(config.kind==='scatter'){option.xAxis=valueAxis;option.yAxis=valueAxis;option.series=[{type:'scatter',symbolSize:10,itemStyle:{opacity:.78,borderColor:dark?'#171b23':'#fff',borderWidth:1},emphasis:{scale:1.5},data:data.scatter}];option.dataZoom=[{type:'inside'},{type:'slider',bottom:10,height:12}];}
  else {
   const categorical={type:'category' as const,data:categories,axisLine:{lineStyle:{color:rule}},axisTick:{show:false},axisLabel:{color:muted,fontSize:11,width:120,overflow:'truncate',margin:12}};
   const bars=!['line','area'].includes(config.kind);
   const categoricalValueAxis={...valueAxis,scale:!bars};
   option.xAxis=horizontal?categoricalValueAxis:categorical;option.yAxis=horizontal?categorical:categoricalValueAxis;
   option.series=names.map((name,index)=>({name,type:bars?'bar':'line',smooth:.22,lineStyle:{width:2.5},symbolSize:6,areaStyle:config.kind==='area'?{opacity:.14}:undefined,barMaxWidth:34,itemStyle:{color:colors[index%colors.length],borderRadius:horizontal?[0,5,5,0]:[5,5,0,0]},label:{show:bars&&names.length===1&&categories.length<=12,position:horizontal?'right':'top',color:muted,fontSize:10,formatter:(p:any)=>formatNumber(Number(p.value))},connectNulls:false,showSymbol:categories.length<25,data:categories.map(cat=>data.points.find(p=>p.category===cat&&p.series===name)?.value??null)}));
   if(categories.length>40){option.dataZoom=[{type:'inside',...(horizontal?{yAxisIndex:0}:{})},{type:'slider',height:12,showDataShadow:false,brushSelect:false,...(horizontal?{yAxisIndex:0,right:2}:{bottom:10}),start:0,end:40/categories.length*100}];}else{option.grid={left:30,right:30,top:90,bottom:34,containLabel:true};}
  }
  chart.setOption(option,{notMerge:true});
 },[config,data,title,scope,dark,accent,oled,motion]);
 const highlight=(index:number,on:boolean)=>{const chart=instance.current;if(!chart)return;chart.dispatchAction({type:'downplay'});if(on)chart.dispatchAction({type:'highlight',seriesIndex:pie?0:index,...(pie?{dataIndex:index}:{})});};
 return <div className="dw-analysis-visual"><div ref={host} className="dw-analysis-chart" role="img" aria-label={title+'，'+scope}/>{showLegend&&<aside className="dw-analysis-legend" aria-label="图例"><div className="dw-analysis-legend-head"><strong>{pie?'分类明细':'系列'} <span>· {items.length}</span></strong>{pie&&<InfoHint label="占比计算说明">占比 = 当前展示分类的数值 / 合计。仅在限制分类数量时，Top N 外的分类不计入。分类较多时，小扇区的标签请在此查看。</InfoHint>}</div>{pie&&<div className="dw-analysis-legend-total"><span>当前展示合计</span><strong>{formatNumber(total)}</strong></div>}<input aria-label="搜索图例" placeholder="搜索名称，不改变统计范围" value={search} onChange={e=>setSearch(e.target.value)}/><div className="dw-analysis-legend-list">{items.filter(i=>i.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(i=><button key={i.name} type="button" title={i.name} onMouseEnter={()=>highlight(i.index,true)} onMouseLeave={()=>highlight(i.index,false)} onFocus={()=>highlight(i.index,true)} onBlur={()=>highlight(i.index,false)} onClick={()=>highlight(i.index,true)}><i style={{background:colors[i.index%colors.length]}}/><span>{i.name}</span>{pie&&<><small>{i.value?.toLocaleString('zh-CN',{maximumFractionDigits:6})}</small><b>{i.percent}</b></>}</button>)}{!items.some(i=>i.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))&&<p>没有匹配的图例</p>}</div></aside>}</div>;
}
