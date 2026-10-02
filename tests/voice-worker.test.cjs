const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const code = fs.readFileSync(require('node:path').join(__dirname, '../voice-worker.js'), 'utf8');
function harness(generate) {
  const messages = [];
  const context = vm.createContext({ self: { postMessage: m => messages.push(m) } });
  vm.runInContext(code, context);
  context.tts = { generate };
  vm.runInContext('modelPromise = Promise.resolve(tts)', context);
  return { context, messages, send: data => context.self.onmessage({ data }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('long unpunctuated input is bounded without losing words', () => {
  const {context} = harness();
  context.input = Array(500).fill('learning').join(' ');
  const parts = vm.runInContext('chunks(input)', context);
  assert.ok(parts.every(p => p.length <= 220));
  assert.equal(parts.join(' '), context.input);
});
test('cancelled generation cannot deliver stale audio; voice and speed propagate', async () => {
  let resolve;
  const options = [];
  const h = harness((text, opts) => { options.push(opts); return new Promise(r => { resolve = r; }); });
  h.send({type:'speak',id:1,text:'Hello.',voice:'am_michael',speed:0.85});
  await tick();
  h.send({type:'stop'});
  resolve({audio:new Float32Array(5),sampling_rate:24000});
  await tick();
  assert.equal(h.messages.filter(m => m.type === 'audio').length,0);
  assert.equal(options[0].voice,'am_michael');
  assert.equal(options[0].speed,0.85);
});
test('playback backpressure, stop and subsequent request do not deadlock', async () => {
  const h = harness(async () => ({audio:new Float32Array(5),sampling_rate:24000}));
  h.send({type:'speak',id:1,text:'Hello. Welcome.',voice:'af_heart',speed:1});
  await tick();
  assert.equal(h.messages.filter(m => m.type === 'audio').length,1);
  h.send({type:'stop'});
  h.send({type:'speak',id:2,text:'Again.',voice:'af_heart',speed:1});
  await tick();
  assert.equal(h.messages.filter(m => m.type === 'audio' && m.id === 2).length,1);
  h.send({type:'consumed',id:1});
  await tick();
  assert.equal(h.messages.filter(m => m.type === 'done').length,0);
  h.send({type:'consumed',id:2});
  await tick();
  assert.equal(h.messages.filter(m => m.type === 'done' && m.id === 2).length,1);
});
