export interface WindowGeometry { x: number; y: number; width: number; height: number; maximized: boolean }
export interface WorkArea { position: { x: number; y: number }; size: { width: number; height: number } }

export function fitWindow(value: unknown, areas: WorkArea[]): WindowGeometry | null {
  const g = value as WindowGeometry;
  if (!g || ![g.x,g.y,g.width,g.height].every(Number.isFinite) || g.width <= 0 || g.height <= 0 || !areas.length) return null;
  const overlap = (a: WorkArea) => Math.max(0,Math.min(g.x+g.width,a.position.x+a.size.width)-Math.max(g.x,a.position.x)) * Math.max(0,Math.min(g.y+g.height,a.position.y+a.size.height)-Math.max(g.y,a.position.y));
  const area = areas.reduce((best,a)=>overlap(a)>overlap(best)?a:best,areas[0]);
  const width = Math.min(Math.max(640,g.width),area.size.width);
  const height = Math.min(Math.max(480,g.height),area.size.height);
  return { x: Math.round(Math.max(area.position.x,Math.min(g.x,area.position.x+area.size.width-width))),
    y: Math.round(Math.max(area.position.y,Math.min(g.y,area.position.y+area.size.height-height))),
    width: Math.round(width),height: Math.round(height),maximized: g.maximized === true };
}
