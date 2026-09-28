import type { DbValue } from '../../ipc/types';

export const IMAGE_TEXT_LIMIT = 64 * 1024 * 1024;
export const THUMBNAIL_TEXT_LIMIT = 2 * 1024 * 1024;
export const IMAGE_PIXEL_LIMIT = 100_000_000;
export interface Base64Image { src: string; mime: string; width:number; height:number; previewable:boolean }

// 只接受有文件签名的内嵌位图，不将任意字符串、URL 或 SVG 当作图片。
function mimeOf(bytes: string): string | null {
  if (bytes.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes)) return 'image/gif';
  if (bytes.startsWith('RIFF') && bytes.slice(8,12) === 'WEBP') return 'image/webp';
  if (bytes.startsWith('BM')) return 'image/bmp';
  return null;
}
function payload(text: string) {
  const trimmed = text.trimStart();
  if (!trimmed.toLowerCase().startsWith('data:')) return trimmed;
  const header = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9_-]+=[^;,]*)*;base64,/i.exec(trimmed);
  return header ? trimmed.slice(header[0].length) : null;
}
export function isImageCandidate(value: DbValue | undefined): boolean {
  if (!value || !['text','trunc'].includes(value[0]) || typeof value[1] !== 'string') return false;
  const head = payload(value[1].slice(0,256));
  if (!head) return false;
  try { return !!mimeOf(atob(head.replace(/\s/g,'').replace(/-/g,'+').replace(/_/g,'/').slice(0,32))); }
  catch { return false; }
}
export function base64Image(text: string): Base64Image | null {
  if (!text || text.length > IMAGE_TEXT_LIMIT) return null;
  const body = payload(text);
  if (!body) return null;
  const base64 = body.replace(/\s/g,'').replace(/-/g,'+').replace(/_/g,'/');
  if (base64.length < 16 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  try {
    const bytes = atob(base64), mime = mimeOf(bytes);
    if (!mime) return null;
    // 解码前读取尺寸，避免很小的压缩字符串展开成异常巨大的画布。
    const u32 = (offset: number, little = false) => new DataView(Uint8Array.from(bytes.slice(offset,offset+4), c=>c.charCodeAt(0)).buffer).getUint32(0,little);
    if (mime==='image/png') {
      // 按块寻找结束标记；IEND 之后的应用附加数据不影响 PNG 图片本身。
      let offset=8,ended=false,hasData=false;
      if(bytes.slice(12,16)!=='IHDR'||u32(8)!==13)return null;
      while(offset+12<=bytes.length){const length=u32(offset),kind=bytes.slice(offset+4,offset+8);if(offset+12+length>bytes.length)return null;if(kind==='IDAT')hasData=true;if(kind==='IEND'){ended=length===0;break;}offset+=12+length;}
      if(!ended||!hasData)return null;
    }
    if (mime==='image/jpeg' && !bytes.endsWith('\xff\xd9')) return null;
    if (mime==='image/gif' && !bytes.endsWith(';')) return null;
    if (mime==='image/webp' && u32(4,true)+8!==bytes.length) return null;
    if (mime==='image/bmp' && u32(2,true)!==bytes.length) return null;
    let width = 0, height = 0;
    if (mime === 'image/png') { width=u32(16);height=u32(20); }
    if (mime === 'image/gif') { width=bytes.charCodeAt(6)|(bytes.charCodeAt(7)<<8);height=bytes.charCodeAt(8)|(bytes.charCodeAt(9)<<8); }
    if (mime === 'image/bmp') { width=u32(18,true);height=Math.abs(u32(22,true)|0); }
    if (mime === 'image/jpeg') {
      let offset=2;
      while(offset+8<bytes.length) {
        if(bytes.charCodeAt(offset++)!==255)break;
        while(bytes.charCodeAt(offset)===255)offset++;
        const marker=bytes.charCodeAt(offset++);
        if(marker===0xda||marker===0xd9)break;
        if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
        const length=(bytes.charCodeAt(offset)<<8)|bytes.charCodeAt(offset+1);
        if(length<2)break;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          height=(bytes.charCodeAt(offset+3)<<8)|bytes.charCodeAt(offset+4);
          width=(bytes.charCodeAt(offset+5)<<8)|bytes.charCodeAt(offset+6);break;
        }
        offset+=length;
      }
    }
    if (mime === 'image/webp') {
      const kind=bytes.slice(12,16),b=(i:number)=>bytes.charCodeAt(i);
      if(kind==='VP8X'){width=1+(b(24)|(b(25)<<8)|(b(26)<<16));height=1+(b(27)|(b(28)<<8)|(b(29)<<16));}
      if(kind==='VP8L'&&b(20)===0x2f){width=1+(b(21)|((b(22)&63)<<8));height=1+((b(22)>>6)|(b(23)<<2)|((b(24)&15)<<10));}
      if(kind==='VP8 '&&bytes.slice(23,26)==='\x9d\x01\x2a'){width=(b(26)|(b(27)<<8))&0x3fff;height=(b(28)|(b(29)<<8))&0x3fff;}
    }
    if (!width || !height) return null;
    return { src: `data:${mime};base64,${base64.padEnd(Math.ceil(base64.length/4)*4,'=')}`, mime, width, height, previewable:width<=32768&&height<=32768&&width*height<=IMAGE_PIXEL_LIMIT };
  } catch { return null; }
}
