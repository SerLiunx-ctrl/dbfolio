const fs = require('node:fs'), ts = require('typescript'), assert = require('node:assert/strict');
const mod = { exports: {} };
let effect, cleanup, callback, disconnected = false;
global.ResizeObserver = class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('src/app/useActiveTabScroll.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(() => ({useLayoutEffect: fn => {effect = fn;}}), mod, mod.exports);
const {revealActiveTab, useActiveTabScroll} = mod.exports;
function fixture(left, right, scale = 1, width = 500) {
  const tab = { getBoundingClientRect: () => ({ left: 100 + left * scale, right: 100 + right * scale }) };
  const strip = { clientWidth: width, offsetWidth: width, clientLeft: 0, scrollLeft: 200,
    getBoundingClientRect: () => ({left: 100, width: width * scale}), children: [tab], querySelector: () => tab };
  return {strip, tab};
}
for (const [name,left,right,scale,width,expected] of [
  ['末尾标签',600,800,1,500,500], ['左侧标签',-100,100,1,500,100],
  ['已可见',50,250,1,500,200], ['缩放150%',600,800,1.5,500,500],
  ['缩放80%',600,800,.8,500,500], ['隐藏容器',600,800,1,0,200],
  ['超宽标签',-50,650,1,500,150],
]) { const {strip,tab}=fixture(left,right,scale,width);revealActiveTab(strip,tab);assert.equal(strip.scrollLeft,expected,name); }
const {strip}=fixture(600,800);
useActiveTabScroll({current:strip}, '恢复的末尾标签', false);cleanup=effect();assert.equal(strip.scrollLeft,500);
strip.scrollLeft=200;callback();assert.equal(strip.scrollLeft,500,'尺寸变化后校正');
cleanup();assert.equal(disconnected,true,'取消尺寸监听');
strip.scrollLeft=200;useActiveTabScroll({current:strip}, '设置页', true);effect();assert.equal(strip.scrollLeft,200,'隐藏时不追踪');
console.log('通过：恢复页签、左右越界、已可见不动、两种缩放、隐藏、超宽、尺寸变化与监听清理。');
