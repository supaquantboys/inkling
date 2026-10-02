const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const code = fs.readFileSync(require('node:path').join(__dirname, '../voice.js'), 'utf8');
function harness() {
  const workers = [], timers = new Map(), messages = [], handlers = {};
  let timerId = 0;
  const bar = {hidden:true}, label = { set textContent(value) { messages.push(value); } };
  class Worker {
    constructor() { this.sent = []; workers.push(this); }
    postMessage(data) { this.sent.push(data); }
    terminate() {}
  }
  class AudioContext { async resume() {} }
  const context = vm.createContext({
    Worker, AudioContext, console, Event,
    setTimeout(fn) { const id=++timerId; timers.set(id,fn); return id; }, clearTimeout(id) { timers.delete(id); },
    localStorage: {getItem:()=>JSON.stringify({voice:'am_puck'})},
    document: {dispatchEvent(){}, getElementById:id=>id==='voice-player'?bar:id==='voice-status'?label:null},
    addEventListener(name, fn) { handlers[name]=fn; },
    speechSynthesis: {cancel(){}},
  });
  context.window = context;
  vm.runInContext(code, context);
  return { voice:context.InklingVoice, workers, timers, messages, handlers };
}
test('voice module immediately preloads saved voice and coalesces startup calls', async () => {
  const h=harness();
  assert.equal(h.workers.length,1);
  assert.equal(h.workers[0].sent[0].type,'preload');
  assert.equal(h.workers[0].sent[0].voice,'am_puck');
  const first=h.voice.preload(), second=h.voice.preload();
  assert.equal(first,second);
  assert.equal(h.workers[0].sent.length,1);
  h.workers[0].onmessage({data:{type:'preload-ready',id:0}});
  assert.equal(await first,true); assert.equal(h.voice.ready,true);
  await h.voice.speak('Hello.',{voice:'am_puck'});
  assert.ok(h.workers[0].sent.some(m=>m.type==='speak'));
  assert.equal(h.messages.some(m=>m.includes('下載')),false);
  h.voice.stop();
});
test('real download progress extends preparation deadline and failure stays false', async () => {
  const h=harness();
  const pending=h.voice.prepare(['Hello.'],{voice:'am_puck'});
  const originalTimer=[...h.timers.keys()][0];
  h.workers[0].onmessage({data:{id:0,type:'preload-progress',message:'下載語音模型：20%'}});
  assert.equal(h.timers.has(originalTimer),false);
  const id=h.workers[0].sent.find(m=>m.type==='prepare').id;
  h.workers[0].onmessage({data:{id,type:'prepare-error'}});
  assert.equal(await pending,false);
  assert.equal(h.timers.size,0);
});
test('failed preload retries with same worker when connection returns', async () => {
  const h=harness();
  h.workers[0].onmessage({data:{id:0,type:'preload-error'}});
  h.handlers.online();
  assert.equal(h.workers.length,1);
  const requests=h.workers[0].sent.filter(m=>m.type==='preload');
  assert.equal(requests.length,2);
  assert.equal(requests[1].voice,'am_puck');
});

test('half-speed preview is prepared once, gated until ready and distinct from normal speed', async () => {
  const h=harness(), settings={voice:'af_bella',voiceSpeed:'0.5'};
  const first=h.voice.preparePreview(settings), second=h.voice.preparePreview(settings);
  assert.equal(first,second); assert.equal(h.voice.previewState(settings),'loading');
  const requests=h.workers[0].sent.filter(m=>m.type==='prepare');
  assert.equal(requests.length,1); assert.equal(requests[0].speed,0.5);
  assert.equal(requests[0].texts[0],h.voice.previewText);
  h.workers[0].onmessage({data:{type:'prepare-ready',id:requests[0].id}});
  assert.equal(await first,true); assert.equal(h.voice.previewState(settings),'ready');
  assert.equal(h.voice.previewState({voice:'af_bella',voiceSpeed:'1'}),'idle');
  await h.voice.speak(h.voice.previewText,settings);
  assert.equal(h.workers[0].sent.find(m=>m.type==='speak').speed,0.5);
  h.voice.clearCache(); assert.equal(h.voice.previewState(settings),'idle');
});
