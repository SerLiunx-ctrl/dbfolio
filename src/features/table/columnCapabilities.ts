import type { Engine } from '../../ipc/types';

export function columnCapabilities(engine: Engine) {
  return {
    unsigned: engine === 'mysql',
    onUpdate: engine === 'mysql',
    comment: engine !== 'sqlite',
    identityEditable: engine !== 'postgres',
    insertPosition: engine === 'mysql',
    reorder: engine !== 'postgres',
  };
}

export function splitColumnType(raw: string, engine: Engine) {
  const text = engine === 'mysql' ? raw.replace(/\s+(unsigned|zerofill)\b/gi, '').trim() : raw.trim();
  const match = text.match(/^([^()]+)\((.*)\)(.*)$/);
  return match ? { type: (match[1].trim() + match[3]).trim(), args: match[2] } : { type: text, args: '' };
}

export function joinColumnType(type: string, args: string) {
  if (!args) return type;
  const suffix = type.match(/(\s+(?:with|without) time zone|\[\])+$/i)?.[0] ?? '';
  return type.slice(0, type.length - suffix.length) + `(${args})` + suffix;
}
