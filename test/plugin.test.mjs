import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import plugin, { details, matches, groups, groupTitle, summary } from '../index.js'

const directory = path.resolve('/repo')
const nested = path.join('a', 'x')

class Box {
  constructor(ctx, props = {}) { this.kids = []; this.visible = true; Object.assign(this, props) }
  add(node) { if(node.parent)node.parent.remove(node); this.kids.push(node); node.parent = this }
  insertBefore(node, before) { if(node.parent)node.parent.remove(node); this.kids.splice(this.kids.indexOf(before),0,node); node.parent=this }
  remove(node) { this.kids.splice(this.kids.indexOf(node),1); node.parent=undefined }
  getChildren() { return this.kids }
  destroy() { this.isDestroyed = true; this.parent?.remove(this) }
  destroyRecursively() { for(const child of [...this.kids])child.destroyRecursively(); this.destroy() }
}
class Text extends Box { get plainText() { return this.content ?? '' } }
class Scroll extends Box { scrollTo(){} }
const part = (id, tool, input, output) => ({ id, type: 'tool', tool, state: { status: 'completed', input, output } })
const messages = [{id:'user1',role:'user'}, {id:'m1',role:'assistant',parentID:'user1'}]

function setup(parts, specs) {
  const root=new Box(), scroll=new Scroll(null,{stickyScroll:true,stickyStart:'bottom',scrollHeight:100})
  root.add(scroll); scroll.add(new Box(null,{id:'user1'}))
  const hosts=[], labels=[]
  for(const spec of specs){
    const host=new Box(), label=new Text(null,{content:spec.label}); scroll.add(host)
    if(spec.block){ host.add(label); host.add(new Box(null,{diff:'diff body'})) }
    else { const row=new Box(); host.add(row);row.add(new Text(null,{content:spec.icon??'→'}));row.add(label) }
    hosts.push(host);labels.push(label)
  }
  const layers=[],disposers=[],events={},selected={text:''}
  const api={renderer:{root,getSelection:()=>({getSelectedText:()=>selected.text})},route:{current:{name:'session',params:{sessionID:'s1'}},navigate(){}},
    theme:{current:{text:'#ddd',background:'#222',backgroundPanel:'#333',borderSubtle:'#444'}},
    state:{path:{directory},session:{messages:()=>messages},part:id=>id==='m1'?parts:[]},
    event:{on:(name,fn)=>{(events[name]??=[]).push(fn);return()=>{}}},lifecycle:{onDispose:fn=>disposers.push(fn)},
    keymap:{registerLayer:layer=>layers.push(layer),dispatchCommand:name=>layers.flatMap(l=>l.commands).find(c=>c.name===name)?.run()},
    ui:{toast(){},dialog:{replace(){}},DialogSelect(){}},
  }
  return {api,root,scroll,hosts,labels,selected,update:()=>events['message.updated'].forEach(fn=>fn()),dispose:()=>disposers.forEach(fn=>fn()),widgets:()=>scroll.kids.filter(n=>n.id?.startsWith('fold-tools-'))}
}

test('inline details show outputs only; full record viewer retains inputs',()=>{
  for(const tool of ['read','glob','grep','bash','edit','write','apply_patch','task','question','todowrite','websearch','custom_mcp']){
    assert.match(details(part(tool,tool,{command:'echo yes',x:1},'full result')),/full result/)
  }
  const call = part('shell','bash',{command:'INPUT_SENTINEL'},'OUTPUT_SENTINEL')
  assert.equal(details(call),'OUTPUT_SENTINEL')
  assert.match(details(call,true),/INPUT_SENTINEL/)
  assert.match(details({tool:'read',state:{status:'error',error:'failed'}}),/错误\nfailed/)
  assert.match(details({tool:'read',state:{status:'completed',time:{compacted:1},output:'stale'}}),/已被 OpenCode 压缩/)
})

test('matching distinguishes offsets, paths and filename prefixes',()=>{
  assert.equal(matches(`Read ${nested} [offset=10]`,part('1','read',{filePath:path.join(directory,nested),offset:10}),directory),true)
  assert.equal(matches(`Read ${nested} [offset=20]`,part('1','read',{filePath:path.join(directory,nested),offset:10}),directory),false)
  assert.equal(matches('← Edit a.tsx',part('1','edit',{filePath:'a.ts'}),directory),false)
  assert.equal(matches('Glob "*.js" in src (2 matches)',part('1','glob',{pattern:'*.js',path:path.join(directory,'src')}),directory),true)
  assert.equal(matches('Glob "*.js" in test (2 matches)',part('1','glob',{pattern:'*.js',path:path.join(directory,'src')}),directory),false)
  assert.equal(matches(`Read ${nested}`,part('1','read',{filePath:'./a/x'}),directory),true)
})

test('paths outside the project use absolute or home labels',()=>{
  const home = os.homedir()
  const project = path.join(home,'project')
  const sibling = path.join(home,'other','x')
  assert.equal(summary(part('1','read',{filePath:sibling}),project),`Read ~${path.sep}${path.join('other','x')}`)
  const outside = path.join(path.parse(directory).root,'outside','x')
  assert.equal(summary(part('2','read',{filePath:outside}),directory),`Read ${outside}`)
  assert.equal(summary(part('3','read',{filePath:'..'}),directory),`Read ${path.dirname(directory)}`)
})

test('each tool call stays separate and in original order',()=>{
  const parts=[part('1','read',{},''),part('2','glob',{},''),part('3','bash',{},''),part('4','grep',{},''),{type:'text',text:'commentary'},part('5','read',{},'')]
  const list=groups(messages,id=>id==='m1'?parts:[])
  assert.deepEqual(list.map(g=>g.parts.length),[1,1,1,1,1])
  assert.deepEqual(list.map(g=>g.id),['1','2','3','4','5'])
  assert.match(groupTitle(list[0],'/repo'),/^Read /)
  parts[1].state.status='running'
  assert.match(groupTitle(list[1],'/repo'),/^Glob /)
})

test('independent headers, click open/close, background only when open, Ctrl+O, refresh and cleanup',async()=>{
  const parts=[part('p1','read',{filePath:path.join(directory,nested)},'first'),part('p2','read',{filePath:path.join(directory,nested)},'second')]
  const t=setup(parts,[{label:`Read ${nested}`},{label:`Read ${nested}`}]); await plugin.tui(t.api)
  try{
    t.update(); assert.equal(t.widgets().length,2)
    const [widget]=t.widgets(),[header,body]=widget.kids
    assert.equal(header.content,`▸ Read ${nested}`)
    assert.equal(body.visible,false);assert.equal(widget.backgroundColor,'#222')
    assert.equal(t.hosts.every(h=>h.visible===false),true)
    header.onMouseUp({stopPropagation(){}})
    assert.equal(body.visible,true);assert.equal(widget.backgroundColor,'#222');assert.equal(body.backgroundColor,'#333')
    assert.match(body.kids[0].content,/first/);assert.doesNotMatch(body.kids[0].content,/second/)
    assert.equal(t.widgets()[1].kids[1].visible,false)
    t.selected.text='selection';header.onMouseUp({});assert.equal(body.visible,true);t.selected.text=''
    header.onMouseUp({});assert.equal(body.visible,false);assert.equal(widget.backgroundColor,'#222')
    t.api.keymap.dispatchCommand('fold_tools.toggle');assert.equal(body.visible,true)
    parts[1].state.output='updated';t.update();assert.match(t.widgets()[1].kids[1].kids[0].content,/updated/)
    t.update();assert.equal(t.widgets().length,2)
    t.api.keymap.dispatchCommand('fold_tools.toggle');assert.equal(body.visible,false)
  }finally{t.dispose()}
  assert.equal(t.widgets().length,0);assert.equal(t.hosts.every(h=>h.visible),true)
})

test('multi-file apply_patch retains all native colored diffs on expand',async()=>{
  const p=part('patch','apply_patch',{patchText:'x'},'done');p.state.metadata={files:[{type:'update',relativePath:'a.ts'},{type:'add',relativePath:'b.ts'}]}
  const t=setup([p],[{label:'← Patched a.ts',block:true},{label:'# Created b.ts',block:true}]);await plugin.tui(t.api)
  try{
    t.update();assert.equal(t.widgets().length,1)
    const [widget]=t.widgets();widget.kids[0].onMouseUp({})
    assert.equal(widget.visible,true);assert.equal(t.hosts.every(h=>h.visible),true)
    assert.equal(t.labels.every(label=>label.visible===false),true)
    widget.kids[0].onMouseUp({});assert.equal(widget.visible,true);assert.equal(t.hosts.every(h=>!h.visible),true)
  }finally{t.dispose()}
})

test('tool-shaped text inside native output is never mapped as another call',async()=>{
  const parts=[part('b','bash',{command:'echo text'},'Read hidden'),part('r','read',{filePath:'hidden'},'secret')]
  const t=setup(parts,[]),host=new Box(),inner=new Box();host.add(inner);inner.add(new Text(null,{content:'$ echo text'}));inner.add(new Text(null,{content:'Read hidden'}));t.scroll.add(host)
  await plugin.tui(t.api)
  try{t.update();assert.equal(t.widgets().length,1);assert.match(t.widgets()[0].kids[0].content,/Shell/)}finally{t.dispose()}
})

test('shell workdir title does not prevent matching command',async()=>{
  const t=setup([part('b','bash',{command:'pwd',workdir:'/else'},'/else')],[])
  const host=new Box(),inner=new Box();host.add(new Text(null,{content:'# Running in /else'}));host.add(inner)
  inner.add(new Text(null,{content:'$ pwd'}));inner.add(new Text(null,{content:'/else'}));t.scroll.add(host)
  await plugin.tui(t.api)
  try{t.update();assert.equal(t.widgets().length,1);assert.match(t.widgets()[0].kids[0].content,/Shell pwd/)}finally{t.dispose()}
})

test('overlapping consecutive patches retain call ownership',async()=>{
  const p1=part('p1','apply_patch',{patchText:'first'},'one'),p2=part('p2','apply_patch',{patchText:'second'},'two')
  p1.state.metadata={files:[{type:'update',relativePath:'a'},{type:'update',relativePath:'b'}]}
  p2.state.metadata={files:[{type:'update',relativePath:'b'},{type:'update',relativePath:'c'}]}
  const t=setup([p1,p2],['a','b','b','c'].map(x=>({label:'← Patched '+x,block:true})));await plugin.tui(t.api)
  try{
    t.update();assert.equal(t.widgets().length,2);t.widgets()[0].kids[0].onMouseUp({})
    assert.deepEqual(t.hosts.map(h=>h.visible),[true,true,false,false])
  }finally{t.dispose()}
})

test('failed patch has expandable error details',async()=>{
  const p=part('p','apply_patch',{patchText:'bad'},'');p.state={...p.state,status:'error',error:'patch failed: missing file'}
  const t=setup([p],[{label:'Patch failed',icon:'%'}]);await plugin.tui(t.api)
  try{t.update();assert.equal(t.widgets().length,1);t.widgets()[0].kids[0].onMouseUp({});assert.match(t.widgets()[0].kids[1].kids[0].content,/missing file/)}finally{t.dispose()}
})

test('native spacing keeps single-line tools adjacent and separates multiline content',async()=>{
  const t=setup([part('a','read',{filePath:'a'},'a'),part('b','bash',{command:'echo ok'},'ok')],[{label:'Read a'},{label:'echo ok'}])
  await plugin.tui(t.api);t.update()
  const [first,second]=t.widgets()
  const paragraph=new Box(null,{height:3})
  t.scroll.insertBefore(paragraph,first)
  first.onLifecyclePass();assert.equal(first.marginTop,1)
  first.height=1
  second.onLifecyclePass();assert.equal(second.marginTop,0)
  first.height=6
  second.onLifecyclePass();assert.equal(second.marginTop,1)
  first.height=1
  second.onLifecyclePass();assert.equal(second.marginTop,0)
  paragraph.height=1
  first.onLifecyclePass();assert.equal(first.marginTop,0)
  t.dispose()
})
