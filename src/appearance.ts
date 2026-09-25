// 配色保留语义状态色；强调色独立由用户配置。
export const SURFACE_PALETTES: Record<string, {light: string; dark: string; radius: number}> = {
  ocean: {light:'#eef5fa',dark:'#172633',radius:8},
  forest: {light:'#f0f5ed',dark:'#202b22',radius:6},
  sand: {light:'#faf4e8',dark:'#30291f',radius:4},
  lavender: {light:'#f4f0fa',dark:'#282236',radius:12},
  slate: {light:'#f0f1f3',dark:'#24272c',radius:2},
  rose: {light:'#faf0f2',dark:'#322329',radius:8},
};
export function mixColor(a:string,b:string,weight:number) {
  return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-weight)+parseInt(b.slice(i,i+2),16)*weight).toString(16).padStart(2,'0')).join('');
}
export function surfaceColors(style:string,dark:boolean) {
  if(style === "oled") return {background:"#000000",surface:"#000000",foreground:"#e6e8ed",muted:"#adb9c9",border:"#292929",radius:6};
  const palette=SURFACE_PALETTES[style];
  const background=palette ? (dark?palette.dark:palette.light) : (dark?'#23272e':'#ffffff');
  return {background,surface:mixColor(background,dark?'#ffffff':'#ffffff',dark?.035:.45),foreground:dark?'#e6e8ed':'#253449',muted:dark?'#adb9c9':'#596779',border:mixColor(background,dark?'#ffffff':'#253449',dark?.22:.2),radius:palette?.radius??6};
}
