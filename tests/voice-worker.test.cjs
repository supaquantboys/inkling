const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const code = fs.readFileSync(require('node:path').join(__dirname, '../voice-worker.js'), 'utf8');
function harness(generate) {
  const messages = [];
  const cache = new Map();
  const context = vm.createContext({
    importScripts() {}, setTimeout, clearTimeout,
    VoiceCache: {
      clear: async () => cache.clear(),
      key: (text, voice, speed) => JSON.stringify([text, voice, speed]),
      get: async key => cache.get(key),
      put: async (key, samples, sampleRate) => cache.set(key, { samples: samples.slice(), sampleRate }),
    },
    self: { postMessage: m => messages.push(m) },
  });
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

test('same text, voice and speed reuse audio; changing voice or speed generates anew', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { audio: new Float32Array([0.1, 0.2]), sampling_rate: 24000 }; });
  const play = async (id, voice, speed) => {
    h.send({type:'speak',id,text:'Hello.',voice,speed});
    await tick();
    const audio = h.messages.find(m => m.type === 'audio' && m.id === id);
    assert.ok(audio);
    h.send({type:'consumed',id}); await tick();
    return audio;
  };
  assert.equal((await play(1,'af_heart',1)).cached,false);
  assert.equal((await play(2,'af_heart',1)).cached,true);
  assert.equal(calls,1);
  await play(3,'am_michael',1);
  await play(4,'af_heart',0.85);
  assert.equal(calls,3);
});
test('preload shares model and does not interrupt active playback', async () => {
  const h = harness(async () => ({audio:new Float32Array(5),sampling_rate:24000}));
  h.send({type:'speak',id:1,text:'Hello.',voice:'af_heart',speed:1});
  await tick();
  h.send({type:'preload'}); await tick();
  assert.ok(h.messages.some(m => m.type === 'preload-ready'));
  h.send({type:'consumed',id:1}); await tick();
  assert.ok(h.messages.some(m => m.type === 'done' && m.id === 1));
});

test('all six selected voices reach the model unchanged', async () => {
  const generated = [];
  const h = harness(async (text, options) => { generated.push(options.voice); return { audio: new Float32Array(5), sampling_rate: 24000 }; });
  const voices = ['af_heart','af_bella','af_nicole','am_michael','am_fenrir','am_puck'];
  for (let i = 0; i < voices.length; i++) {
    h.send({type:'speak',id:i+1,text:'Hello.',voice:voices[i],speed:1});
    await tick(); h.send({type:'consumed',id:i+1}); await tick();
  }
  assert.deepEqual(generated, voices);
});
test('prepared content plays entirely from cache', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { audio: new Float32Array(5), sampling_rate: 24000 }; });
  h.send({type:'prepare',id:50,texts:['Hello. Welcome.','Hello.'],voice:'af_bella',speed:1});
  for (let i=0;i<30 && !h.messages.some(m=>m.type==='prepare-ready');i++) await new Promise(r=>setTimeout(r,5));
  assert.ok(h.messages.some(m=>m.type==='prepare-ready'));
  assert.equal(calls,2);
  h.send({type:'speak',id:1,text:'Hello.',voice:'af_bella',speed:1}); await tick();
  assert.equal(h.messages.find(m=>m.type==='audio' && m.id===1).cached,true);
  assert.equal(calls,2);
  h.send({type:'consumed',id:1}); await tick();
});

test('clearing audio cancels unfinished preparation and prevents cache repopulation', async () => {
  let finish;
  const h = harness(async () => new Promise(resolve => { finish = resolve; }));
  h.send({type:'prepare',id:50,texts:['Hello. Welcome.'],voice:'af_heart',speed:1});
  await tick();
  h.send({type:'clear-cache'});
  finish({audio:new Float32Array(5),sampling_rate:24000});
  await tick();
  assert.ok(h.messages.some(m=>m.type==='prepare-error'));
  assert.equal(h.messages.filter(m=>m.type==='prepare-ready').length,0);
});

test('cached diary playback does not wait for unfinished background inference', async () => {
  let finish;
  const h = harness(async text => text === 'Slow.' ? new Promise(resolve => { finish = resolve; }) : {audio:new Float32Array(5),sampling_rate:24000});
  h.send({type:'prepare',id:50,texts:['Hello.'],voice:'af_heart',speed:1});
  for(let i=0;i<30 && !h.messages.some(m=>m.type==='prepare-ready');i++) await new Promise(r=>setTimeout(r,5));
  h.send({type:'prepare',id:51,texts:['Slow.'],voice:'af_heart',speed:1}); await tick();
  assert.ok(finish);
  h.send({type:'speak',id:1,text:'Hello.',voice:'af_heart',speed:1}); await tick();
  assert.equal(h.messages.find(m=>m.type==='audio' && m.id===1)?.cached,true);
  h.send({type:'stop'});
  finish({audio:new Float32Array(5),sampling_rate:24000}); await tick();
});
