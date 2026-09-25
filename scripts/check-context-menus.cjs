const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync('src/app/contextMenuPosition.ts', 'utf8');
const moduleScope = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, moduleScope);
const position = moduleScope.exports.contextMenuPosition;
const viewport = {left:0,top:0,width:800,height:600};
for (const [name,x,y,w,h,left,top] of [
 ['normal',100,100,180,200,100,100],
 ['bottom',100,590,180,200,100,390],
 ['right',790,100,180,200,610,100],
 ['corner',790,590,180,200,610,390],
 ['negative',-20,-10,180,200,8,8],
 ['tall',790,590,180,584,610,8],
]) {
 const actual=position(x,y,w,h,viewport);
 assert.equal(actual.left,left,name);assert.equal(actual.top,top,name);
 assert.ok(actual.left+w<=792 && actual.top+h<=592,name);
}
const offset=position(890,690,180,200,{left:100,top:100,width:800,height:600});
assert.equal(offset.left,710);assert.equal(offset.top,490);
let checked=0;
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())scan(file);else if(file.endsWith('.tsx')){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)==='MenuItem'){assert.ok(node.attributes.properties.some(p=>p.name?.getText(source)==='icon'),file+' 缺少菜单图标');checked++;}ts.forEachChild(node,visit);}visit(source);
}}}
scan('src');
console.log(`7 个菜单定位场景通过；${checked} 个菜单项均有图标。`);
