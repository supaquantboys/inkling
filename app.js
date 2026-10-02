'use strict';

/* =========================================================
   Inkling 英文日記教練 v0.1
   純前端 PWA：資料存在瀏覽器 localStorage，AI 走 Gemini API
   ========================================================= */

const APP_VERSION = '0.2.0';

const KEYS = {
  entries: 'inkling.entries',
  cards: 'inkling.cards',
  settings: 'inkling.settings',
  draft: 'inkling.draft',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  level: 'B1',
  style: 'natural',
  voiceEngine: 'kokoro',
  voice: 'af_heart',
  voiceSpeed: '1',
};

const MODEL_SUGGESTIONS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest'];

const LEVELS = {
  A2: { zh: '初級', desc: '常用字、短句就好', en: 'A2 (elementary): keep vocabulary simple and high-frequency, short sentences.' },
  B1: { zh: '中級', desc: '日常對話沒問題，想寫得更順', en: 'B1 (intermediate): everyday vocabulary, natural but not fancy.' },
  B2: { zh: '中高級', desc: '想學更道地的搭配詞', en: 'B2 (upper-intermediate): natural collocations and some idiomatic phrasing.' },
  C1: { zh: '進階', desc: '追求接近母語者的語感', en: 'C1 (advanced): near-native phrasing, nuance and register.' },
};

const TAGS = ['時態', '冠詞', '介系詞', '單複數', '主動詞一致', '用詞', '搭配詞', '語序', '拼字', '標點', '中翻英', '更自然'];
const NO_AUTO_CARD = new Set(['更自然', '標點', '拼字']);

// 複習間隔（天）：Leitner 盒子 0–6
const INTERVALS = [0, 2, 4, 8, 15, 30, 60];

const PROMPTS = [
  '今天吃到最好吃的一樣東西是什麼？',
  '今天有誰讓你笑了？',
  '今天工作或上課最卡的一件事。',
  '如果今天可以重來，你會改哪件事？',
  '今天花了一筆什麼錢？值得嗎？',
  '最近一直在想的一件事。',
  '今天通勤路上注意到了什麼？',
  '明天最期待做什麼？',
  '今天學到的一件小事。',
  '這週最累的時刻是什麼時候？',
  '今天跟誰聊了天？聊了什麼？',
  '最近在看的劇、書或影片。',
  '今天天氣怎麼樣？影響了你的心情嗎？',
  '最近想買、但還在猶豫的東西。',
];

const ICON = {
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
};

/* ---------- 儲存 ---------- */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    toast('無法儲存資料。請先到設定匯出備份，再清出空間。');
    return false;
  }
}

const state = {
  entries: arr(load(KEYS.entries, [])),
  cards: arr(load(KEYS.cards, [])),
  settings: { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) },
  draft: load(KEYS.draft, '') || '',
  view: 'write',          // write | result | review | journal | settings
  current: null,          // 正在看的日記 id，或 'demo'
  resultFrom: 'write',
  editingId: null,
  promptOffset: 0,
  busy: false,
  writeError: '',
  autoAdded: null,        // { id, n } 剛批改完自動加入的卡片數
  reviewQueue: null,
  reviewShown: false,
  reviewDone: 0,
  showKey: false,
};

const saveEntries = () => save(KEYS.entries, state.entries);
const saveCards = () => save(KEYS.cards, state.cards);
const saveSettings = () => save(KEYS.settings, state.settings);
let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => save(KEYS.draft, state.draft), 300);
}

/* ---------- 小工具 ---------- */

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function norm(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
function hasCJK(s) { return CJK.test(s); }

function countWords(s) {
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const en = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + en;
}

function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
function zhDate(s) { const d = parseDay(s); return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`; }
function enDate(s) { return parseDay(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }

function relDay(n) {
  if (n <= 0) return '今天';
  if (n === 1) return '明天';
  return `${n} 天後`;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- 統計 ---------- */

function streak() {
  const days = new Set(state.entries.map((e) => e.date));
  let d = dayStr();
  if (!days.has(d)) d = addDays(d, -1);
  let n = 0;
  while (days.has(d)) { n += 1; d = addDays(d, -1); }
  return n;
}

function weakTags(limit = 4) {
  const since = addDays(dayStr(), -30);
  const count = {};
  for (const e of state.entries) {
    if (e.date < since || !e.result) continue;
    for (const c of e.result.changes) {
      if (c.tag === '中翻英' || c.tag === '更自然') continue;
      count[c.tag] = (count[c.tag] || 0) + 1;
    }
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function dueCards() {
  const t = dayStr();
  return state.cards
    .filter((c) => c.due <= t)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.created - b.created));
}

/* ---------- 文字差異（逐字 LCS） ---------- */

function tokenize(s) {
  return s.match(/[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|[^\sA-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/g) || [];
}

function diffOps(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { raw.push(['=', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push(['-', A[i]]); i++; }
    else { raw.push(['+', B[j]]); j++; }
  }
  while (i < n) raw.push(['-', A[i++]]);
  while (j < m) raw.push(['+', B[j++]]);

  // 合併相鄰同類
  const merged = [];
  for (const [op, t] of raw) {
    const last = merged[merged.length - 1];
    if (last && last[0] === op) last[1] += t;
    else merged.push([op, t]);
  }

  // 把「改動—空白—改動」併成一組，讀起來是 very like → really liked
  const out = [];
  let k = 0;
  while (k < merged.length) {
    if (merged[k][0] === '=') { out.push(merged[k]); k++; continue; }
    let del = '';
    let ins = '';
    while (k < merged.length) {
      const [op, t] = merged[k];
      if (op === '-') { del += t; k++; }
      else if (op === '+') { ins += t; k++; }
      else if (/^\s+$/.test(t) && k + 1 < merged.length && merged[k + 1][0] !== '=') { del += t; ins += t; k++; }
      else break;
    }
    if (del.trim()) out.push(['-', del]);
    if (ins.trim()) out.push(['+', ins]);
  }
  return out;
}

function renderDiff(orig, rev) {
  if (!orig) return `<p class="to">${esc(rev)}</p>`;
  if (hasCJK(orig)) {
    return `<p class="from">${esc(orig)}</p><p class="to">${esc(rev)}</p>`;
  }
  return diffOps(orig, rev).map(([op, t]) => {
    if (op === '-') return `<del>${esc(t)}</del>`;
    if (op === '+') return `<ins>${esc(t)}</ins>`;
    return esc(t);
  }).join('');
}

// 在自然版本裡，只把真正改到的字用藍筆標出來
function spanInner(orig, rev) {
  if (!orig || hasCJK(orig)) return `<mark>${esc(rev)}</mark>`;
  const ops = diffOps(orig, rev).filter(([op]) => op !== '-');
  const inner = ops.map(([op, t]) => (op === '+' ? `<mark>${esc(t)}</mark>` : esc(t))).join('');
  return inner || esc(rev);
}

function highlightCorrected(text, changes) {
  const spots = [];
  let cursor = 0;
  changes.forEach((c, i) => {
    const r = c.revised;
    if (!r) return;
    let at = text.indexOf(r, cursor);
    if (at < 0) at = text.indexOf(r);
    if (at < 0) return;
    const end = at + r.length;
    if (spots.some((s) => at < s.end && end > s.start)) return;
    spots.push({ start: at, end, i });
    if (at >= cursor) cursor = end;
  });
  spots.sort((a, b) => a.start - b.start);
  let html = '';
  let pos = 0;
  for (const s of spots) {
    const c = changes[s.i];
    html += esc(text.slice(pos, s.start));
    html += `<span class="fix-span" role="button" tabindex="0" data-action="jump" data-i="${s.i}" aria-label="看這處修改的說明">${spanInner(c.original, text.slice(s.start, s.end))}</span>`;
    pos = s.end;
  }
  return html + esc(text.slice(pos));
}

function markTerm(sentence, term) {
  if (!term) return esc(sentence);
  const at = sentence.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return esc(sentence);
  return esc(sentence.slice(0, at)) + `<span class="hl">${esc(sentence.slice(at, at + term.length))}</span>` + esc(sentence.slice(at + term.length));
}

function blankTerm(sentence, term) {
  const at = sentence.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return '';
  return sentence.slice(0, at) + '＿＿＿' + sentence.slice(at + term.length);
}

/* ---------- AI（Gemini） ---------- */

const SYSTEM_PROMPT = `You are a warm, precise English writing coach for adult learners in Taiwan who keep a short daily diary.
The diary may mix Traditional Chinese and English. Chinese parts are things the writer did not know how to say in English.

Do the following:
1. "corrected": rewrite the whole entry as natural, everyday English. Keep the writer's meaning, voice, point of view and level of detail. Never add events, feelings or facts that are not in the original. A diary describes the past day, so use past tense unless the writer clearly means a general fact or a plan.
2. "changes": list the meaningful changes in the order they appear (at most 8).
   - "original": copy the exact substring from the writer's text (it may be Chinese or mixed).
   - "revised": the matching English, copied exactly as it appears inside "corrected".
   - "tag": exactly one of ${TAGS.join('、')}.
   - "explain": Traditional Chinese as used in Taiwan, 1–2 sentences, at most 60 characters. Explain why, not only what.
   Group small related fixes in the same short phrase into one change instead of splitting them.
3. "vocab": 3–5 English words or phrases worth learning from this entry, prioritizing what the writer wrote in Chinese or got wrong.
   - "term": the English word or phrase as it should be learned (base form).
   - "meaning": Traditional Chinese, at most 15 characters.
   - "example": a new, short English sentence (at most 14 words) that contains the term exactly and fits the writer's life.
4. "comment": Traditional Chinese, at most 50 characters: one specific thing the writer did well, then one focus for tomorrow.

If a recurring weak point appears again, say so gently in that change's explanation (for example 「又是時態：…」).
Respond with JSON only, no markdown, in exactly this shape:
{"corrected":"","changes":[{"original":"","revised":"","tag":"","explain":""}],"vocab":[{"term":"","meaning":"","example":""}],"comment":""}`;

function userErr(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

async function callGemini({ system, user, json }) {
  const apiKey = str(state.settings.apiKey);
  const model = str(state.settings.model) || DEFAULT_SETTINGS.model;
  if (!apiKey) throw userErr('先到設定填入 Gemini API 金鑰，才能批改。');

  const body = { contents: [{ role: 'user', parts: [{ text: user }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw userErr('連不上 AI 服務。請確認網路連線，再試一次。');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* 空回應 */ }

  if (!res.ok) {
    const msg = data?.error?.message || '';
    if (res.status === 400 && /api key/i.test(msg)) throw userErr('API 金鑰無效。請到設定重新貼上金鑰。');
    if (res.status === 403) throw userErr('這組金鑰沒有 Gemini API 的使用權限。請到 Google AI Studio 確認。');
    if (res.status === 404) throw userErr(`找不到模型「${model}」。請到設定換一個模型名稱。`);
    if (res.status === 429) throw userErr('請求太頻繁，或今天的免費額度用完了。等一分鐘再試。');
    if (res.status >= 500) throw userErr('AI 服務暫時忙線，稍後再試一次。');
    throw userErr(`批改失敗（${res.status}）${msg ? '：' + msg : ''}`);
  }

  const cand = data?.candidates?.[0];
  if (!cand) {
    if (data?.promptFeedback?.blockReason) throw userErr('這篇內容被 AI 服務擋下了。換個說法再試試。');
    throw userErr('AI 沒有回傳結果，再試一次。');
  }
  const text = arr(cand.content?.parts).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw userErr('AI 沒有回傳結果，再試一次。');
  return text;
}

function parseJSON(text) {
  let t = text.replace(/```json|```/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function normalizeResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const changes = arr(r.changes)
    .map((c) => ({
      original: str(c?.original),
      revised: str(c?.revised),
      tag: TAGS.includes(str(c?.tag)) ? str(c.tag) : '更自然',
      explain: str(c?.explain),
    }))
    .filter((c) => c.revised && norm(c.original) !== norm(c.revised))
    .slice(0, 10);
  const vocab = arr(r.vocab)
    .map((v) => ({ term: str(v?.term), meaning: str(v?.meaning), example: str(v?.example) }))
    .filter((v) => v.term)
    .slice(0, 6);
  const corrected = str(r.corrected);
  if (!corrected) throw userErr('AI 的回覆格式不完整，再試一次。');
  return { corrected, changes, vocab, comment: str(r.comment) };
}

async function correctWithAI(text) {
  const level = LEVELS[state.settings.level] || LEVELS.B1;
  const style = state.settings.style === 'fix'
    ? 'Only fix real errors and translate the Chinese parts. Leave sentences that are already correct as they are.'
    : 'Fix errors, translate the Chinese parts, and also rephrase awkward-but-correct parts so they sound natural to a native speaker.';
  const weak = weakTags().map(([t]) => t).join('、') || 'none yet';
  const user = `Learner level: ${level.en}
Correction style: ${style}
Recurring weak points from recent diaries: ${weak}

Diary entry:
"""
${text}
"""`;
  const out = await callGemini({ system: SYSTEM_PROMPT, user, json: true });
  try {
    return normalizeResult(parseJSON(out));
  } catch (e) {
    if (e.userMessage) throw e;
    throw userErr('AI 的回覆格式不完整，再試一次。');
  }
}

/* ---------- 複習卡 ---------- */

function fixCard(c, entryId) {
  const zh = hasCJK(c.original);
  return {
    key: 'fix:' + norm(c.revised),
    kind: 'fix',
    q: zh ? '這句英文怎麼說？' : '怎麼說比較自然？',
    front: c.original,
    clue: '',
    back: c.revised,
    note: c.explain,
    entryId,
  };
}

function wordCard(v, entryId) {
  return {
    key: 'word:' + norm(v.term),
    kind: 'word',
    q: '英文怎麼說？',
    front: v.meaning || v.term,
    clue: blankTerm(v.example, v.term),
    back: v.term,
    note: v.example,
    entryId,
  };
}

function hasCard(key) { return state.cards.some((c) => c.key === key); }

function addCard(card) {
  if (hasCard(card.key)) return false;
  state.cards.push({ ...card, id: uid(), box: 0, due: dayStr(), created: Date.now() });
  return true;
}

function removeCard(key) {
  state.cards = state.cards.filter((c) => c.key !== key);
}

function autoAddCards(entry) {
  let n = 0;
  for (const v of entry.result.vocab) if (addCard(wordCard(v, entry.id))) n++;
  for (const c of entry.result.changes) {
    if (NO_AUTO_CARD.has(c.tag)) continue;
    if (addCard(fixCard(c, entry.id))) n++;
  }
  saveCards();
  return n;
}

function startReview() {
  state.reviewQueue = dueCards().map((c) => c.id);
  state.reviewShown = false;
  state.reviewDone = 0;
}

function gradeCard(grade) {
  const id = state.reviewQueue[0];
  const card = state.cards.find((c) => c.id === id);
  state.reviewQueue.shift();
  if (!card) { state.reviewShown = false; return; }
  const today = dayStr();
  if (grade === 'again') {
    card.box = 0;
    card.due = today;
    state.reviewQueue.push(id);
  } else if (grade === 'hard') {
    card.box = Math.max(1, card.box);
    card.due = addDays(today, 1);
    state.reviewDone += 1;
  } else {
    card.box = Math.min(card.box + 1, INTERVALS.length - 1);
    card.due = addDays(today, INTERVALS[card.box]);
    state.reviewDone += 1;
  }
  card.reviewed = Date.now();
  saveCards();
  state.reviewShown = false;
}

/* ---------- 範例（沒有金鑰時先看效果） ---------- */

const DEMO = {
  id: 'demo',
  date: dayStr(),
  text: '今天下班後我去了一間新開的拉麵店。The soup is very thick and I very like it. 但是排隊排了四十分鐘，下次我要早點去。I feel a little tired but happy.',
  result: {
    corrected: "After work today, I went to a new ramen shop. The broth was really rich, and I really liked it. But I had to wait in line for forty minutes, so next time I'll go earlier. I felt a little tired but happy.",
    changes: [
      { original: '今天下班後我去了一間新開的拉麵店。', revised: 'After work today, I went to a new ramen shop.', tag: '中翻英', explain: '「新開的」用 new 就夠自然了，after work 是「下班後」最常見的說法。' },
      { original: 'The soup is very thick', revised: 'The broth was really rich', tag: '時態', explain: '日記寫的是已經發生的事，用過去式 was。拉麵的湯頭濃郁通常說 rich broth。' },
      { original: 'I very like it', revised: 'I really liked it', tag: '語序', explain: 'very 不能直接修飾動詞，要說 really like 或 like it a lot。' },
      { original: '但是排隊排了四十分鐘，下次我要早點去。', revised: "But I had to wait in line for forty minutes, so next time I'll go earlier.", tag: '中翻英', explain: '「排隊」是 wait in line；用 so 把原因和決定接起來更順。' },
      { original: 'I feel a little tired', revised: 'I felt a little tired', tag: '時態', explain: '又是時態：描述今天當下的感受，一樣用過去式 felt。' },
    ],
    vocab: [
      { term: 'wait in line', meaning: '排隊', example: 'We waited in line for an hour to get in.' },
      { term: 'rich broth', meaning: '濃郁的湯頭', example: 'This shop is famous for its rich broth.' },
      { term: 'after work', meaning: '下班後', example: 'I usually go to the gym after work.' },
      { term: 'really', meaning: '真的（修飾動詞）', example: 'I really enjoyed the movie last night.' },
    ],
    comment: '中英混寫很自然，把整天的感受都寫到了！明天試著全部用過去式描述。',
  },
};

/* ---------- 畫面：寫日記 ---------- */

function promptText() {
  const base = parseDay(dayStr()).getTime() / 86400000;
  return PROMPTS[(Math.floor(base) + state.promptOffset) % PROMPTS.length];
}

function streakBadge() {
  const n = streak();
  if (!n) return `<div class="streak zero" aria-label="今天開始累積連續天數"><strong>今天開始</strong><span>連續天數</span></div>`;
  return `<div class="streak" aria-label="已連續寫了 ${n} 天"><strong>${n}</strong><span>天連續</span></div>`;
}

function viewWrite() {
  const today = dayStr();
  const todays = state.entries.filter((e) => e.date === today);
  const editing = state.editingId && state.entries.find((e) => e.id === state.editingId);
  const busy = state.busy;
  let cta = state.editingId ? '重新批改' : '請教練批改';
  if (busy) cta = '<span class="pencil-loader" aria-hidden="true"></span>教練批改中…';

  return `
  <header class="page-head">
    <div>
      <p class="en-date">${esc(enDate(today))}</p>
      <h1>${esc(zhDate(today))}</h1>
    </div>
    ${streakBadge()}
  </header>

  ${editing ? `<p class="notice">正在修改 ${esc(zhDate(editing.date))} 的日記。<button class="link" data-action="cancel-edit">取消修改</button></p>` : `
  <div class="prompt">
    <p>${esc(promptText())}</p>
    <button class="link" data-action="next-prompt">換一題</button>
  </div>`}

  <label class="sr-only" for="entry">今天的日記</label>
  <div class="paper">
    <textarea id="entry" class="entry" spellcheck="false" autocapitalize="sentences"
      placeholder="隨便寫幾句就好。不會的地方直接寫中文，例如：Today I 跟朋友去爬山, and it was 超累。"
      ${busy ? 'readonly' : ''}>${esc(state.draft)}</textarea>
  </div>
  <div class="write-meta">
    <span id="count">${countWords(state.draft)} 字</span>
    <span>中英混寫都可以</span>
  </div>

  <p class="form-error" id="write-error" role="alert">${esc(state.writeError)}</p>

  <button class="btn primary block" data-action="submit" ${busy ? 'disabled aria-busy="true"' : ''}>${cta}</button>

  ${!str(state.settings.apiKey) ? `
  <p class="hint">還沒設定 AI 金鑰。<button class="link" data-action="demo">先看範例批改</button>或<button class="link" data-action="tab" data-tab="settings">前往設定</button></p>` : ''}
  ${todays.length && !editing ? `
  <p class="hint">今天已經寫了 ${todays.length} 篇。<button class="link" data-action="open-entry" data-id="${esc(todays[todays.length - 1].id)}">看今天的批改</button></p>` : ''}
  `;
}

/* ---------- 畫面：批改結果 ---------- */

function currentEntry() {
  if (state.current === 'demo') return DEMO;
  return state.entries.find((e) => e.id === state.current) || null;
}

function changeItem(c, i, demo) {
  const key = 'fix:' + norm(c.revised);
  const on = hasCard(key);
  return `
  <li class="change" id="chg-${i}">
    <div class="diff">${renderDiff(c.original, c.revised)}</div>
    <p class="explain"><span class="tag">${esc(c.tag)}</span>${esc(c.explain)}</p>
    ${demo ? '' : cardToggle('fix', i, on)}
  </li>`;
}

function wordItem(v, i, demo) {
  const on = hasCard('word:' + norm(v.term));
  return `
  <li class="word">
    <div class="word-head">
      <span class="term" lang="en">${esc(v.term)}</span>
      <button class="icon-btn" data-action="speak" data-text="${esc(v.term)}" aria-label="朗讀 ${esc(v.term)}">${ICON.speaker}</button>
    </div>
    <p class="meaning">${esc(v.meaning)}</p>
    ${v.example ? `<p class="example" lang="en">${markTerm(v.example, v.term)}</p>` : ''}
    ${demo ? '' : cardToggle('word', i, on)}
  </li>`;
}

function cardToggle(kind, i, on) {
  return `<button class="card-toggle" data-action="toggle-card" data-kind="${kind}" data-i="${i}" aria-pressed="${on}">${on ? ICON.check + '已加入複習' : ICON.plus + '加入複習'}</button>`;
}

function viewResult() {
  const entry = currentEntry();
  if (!entry) { state.view = 'write'; return viewWrite(); }
  const r = entry.result;
  const demo = entry.id === 'demo';
  const backLabel = state.resultFrom === 'journal' ? '日記本' : '寫日記';
  const auto = state.autoAdded && state.autoAdded.id === entry.id ? state.autoAdded.n : 0;

  return `
  <div class="topbar"><button class="back" data-action="back">${ICON.back}${backLabel}</button></div>
  <header class="page-head compact">
    <div>
      <p class="en-date">${esc(enDate(entry.date))}</p>
      <h1>${esc(zhDate(entry.date))}</h1>
    </div>
  </header>

  ${demo ? '<p class="notice">這是範例。設定好 AI 金鑰後，就能批改你自己的日記。</p>' : ''}

  <section aria-labelledby="h-natural">
    <div class="section-head">
      <h2 id="h-natural">自然的寫法</h2>
      <button class="btn small" data-action="speak-corrected">${ICON.speaker}朗讀</button>
    </div>
    <p class="corrected" lang="en">${highlightCorrected(r.corrected, r.changes)}</p>
    <details class="original">
      <summary>看我原本寫的</summary>
      <p>${esc(entry.text)}</p>
    </details>
    ${r.comment ? `<p class="coach">${esc(r.comment)}</p>` : ''}
  </section>

  <section aria-labelledby="h-changes">
    <h2 id="h-changes">${r.changes.length ? `改了 ${r.changes.length} 個地方` : '寫得很好，沒有需要修改的地方'}</h2>
    ${auto ? `<p class="auto-note">已自動加入 ${auto} 張複習卡，不需要的可以取消。</p>` : ''}
    <ol class="changes">${r.changes.map((c, i) => changeItem(c, i, demo)).join('')}</ol>
  </section>

  ${r.vocab.length ? `
  <section aria-labelledby="h-vocab">
    <h2 id="h-vocab">值得記下來的說法</h2>
    <ul class="vocab">${r.vocab.map((v, i) => wordItem(v, i, demo)).join('')}</ul>
  </section>` : ''}

  <div class="result-actions">
    ${demo ? `<button class="btn primary block" data-action="tab" data-tab="settings">設定 AI 金鑰</button>` : `
      ${state.resultFrom === 'write' ? `<button class="btn primary block" data-action="go-review">開始複習</button>` : ''}
      <button class="btn secondary block" data-action="revise">修改後重新批改</button>
      ${state.resultFrom === 'journal' ? `<button class="btn danger block" data-action="delete-entry">刪除這篇日記</button>` : ''}
    `}
  </div>`;
}

/* ---------- 畫面：複習 ---------- */

function viewReview() {
  const total = state.cards.length;
  const mastered = state.cards.filter((c) => c.box >= 4).length;
  const head = `
  <header class="page-head">
    <div>
      <h1>複習</h1>
      <p class="sub">${total ? `共 ${total} 張卡片，${mastered} 張已經熟了` : '從日記裡挑出來的單字和句子'}</p>
    </div>
  </header>`;

  if (!total) {
    return head + `
    <div class="empty">
      <p>還沒有複習卡。寫一篇日記，教練會挑出值得記下來的說法。</p>
      <button class="btn primary" data-action="tab" data-tab="write">去寫日記</button>
    </div>`;
  }

  if (!state.reviewQueue) startReview();
  const queue = state.reviewQueue;

  if (!queue.length) {
    const next = state.cards.reduce((min, c) => (min === null || c.due < min ? c.due : min), null);
    const nextCount = state.cards.filter((c) => c.due === next).length;
    const gap = next ? daysBetween(dayStr(), next) : 0;
    return head + `
    <div class="empty">
      <p>${state.reviewDone ? `複習完 ${state.reviewDone} 張了。` : '今天沒有要複習的卡片。'}<br>下一批是${relDay(gap)}，共 ${nextCount} 張。</p>
      <button class="btn primary" data-action="tab" data-tab="write">寫今天的日記</button>
    </div>`;
  }

  const card = state.cards.find((c) => c.id === queue[0]);
  if (!card) { queue.shift(); return viewReview(); }
  const frontIsEnglish = !hasCJK(card.front);
  const shown = state.reviewShown;
  const goodBox = Math.min(card.box + 1, INTERVALS.length - 1);

  return head + `
  <div class="review-progress"><span>還剩 ${queue.length} 張</span><span>${card.kind === 'word' ? '單字' : '句子'}</span></div>
  <article class="flash-card" aria-live="polite">
    <p class="q">${esc(card.q)}</p>
    <p class="front${frontIsEnglish ? ' serif' : ''}"${frontIsEnglish ? ' lang="en"' : ''}>${esc(card.front)}</p>
    ${card.clue ? `<p class="clue" lang="en">${esc(card.clue)}</p>` : ''}
    <div class="spacer"></div>
    ${shown ? `
    <div class="answer">
      <div class="answer-line">
        <p class="answer-text" lang="en">${esc(card.back)}</p>
        <button class="icon-btn" data-action="speak" data-text="${esc(card.back)}" aria-label="朗讀答案">${ICON.speaker}</button>
      </div>
      ${card.note ? `<p class="note${hasCJK(card.note) ? '' : ' serif'}"${hasCJK(card.note) ? '' : ' lang="en"'}>${card.kind === 'word' ? markTerm(card.note, card.back) : esc(card.note)}</p>` : ''}
    </div>` : ''}
  </article>
  <div class="review-actions">
    ${shown ? `
    <div class="grades">
      <button class="grade" data-action="grade" data-g="again"><strong>忘了</strong><span>等一下再來</span></button>
      <button class="grade" data-action="grade" data-g="hard"><strong>有點難</strong><span>明天</span></button>
      <button class="grade good" data-action="grade" data-g="good"><strong>記住了</strong><span>${relDay(INTERVALS[goodBox])}</span></button>
    </div>` : `
    <button class="btn primary block" data-action="reveal">看答案</button>`}
  </div>`;
}

/* ---------- 畫面：日記本 ---------- */

function viewJournal() {
  const n = state.entries.length;
  const head = `
  <header class="page-head">
    <div>
      <h1>日記本</h1>
      <p class="sub">${n ? `共寫了 ${n} 篇，目前連續 ${streak()} 天` : '寫過的日記和批改都在這裡'}</p>
    </div>
  </header>`;

  if (!n) {
    return head + `
    <div class="empty">
      <p>日記本還是空的。今天寫第一篇吧。</p>
      <button class="btn primary" data-action="tab" data-tab="write">寫今天的日記</button>
    </div>`;
  }

  const today = dayStr();
  const written = new Set(state.entries.map((e) => e.date));
  const days = [];
  for (let k = 13; k >= 0; k--) {
    const d = addDays(today, -k);
    const dt = parseDay(d);
    days.push(`<span class="day${written.has(d) ? ' on' : ''}${d === today ? ' today' : ''}" title="${esc(zhDate(d))}" aria-label="${esc(zhDate(d))}${written.has(d) ? '，有寫' : '，沒寫'}">${dt.getDate()}</span>`);
  }
  const wroteCount = days.filter((s) => s.includes(' on')).length;

  const weak = weakTags();
  const max = weak.length ? weak[0][1] : 1;

  const sorted = [...state.entries].sort((a, b) => (a.date === b.date ? b.created - a.created : a.date < b.date ? 1 : -1));
  let lastMonth = '';
  let list = '';
  for (const e of sorted) {
    const d = parseDay(e.date);
    const month = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (month !== lastMonth) {
      if (lastMonth) list += '</ul>';
      list += `<h3 class="month">${month}</h3><ul class="entries">`;
      lastMonth = month;
    }
    list += `
    <li>
      <button class="entry-row" data-action="open-entry" data-id="${esc(e.id)}">
        <span class="entry-date"><strong>${d.getDate()}</strong><span>週${WEEK_SHORT[d.getDay()]}</span></span>
        <span>
          <span class="entry-snippet" lang="en">${esc(e.result?.corrected || e.text)}</span>
          <span class="entry-count">${e.result ? `改了 ${e.result.changes.length} 處，學了 ${e.result.vocab.length} 個說法` : '還沒批改'}</span>
        </span>
      </button>
    </li>`;
  }
  if (lastMonth) list += '</ul>';

  return head + `
  <section aria-labelledby="h-days">
    <h2 id="h-days" class="sr-only">最近兩週</h2>
    <div class="days">${days.join('')}</div>
    <p class="days-caption">最近兩週寫了 ${wroteCount} 天。</p>
  </section>

  ${weak.length ? `
  <section aria-labelledby="h-weak">
    <h2 id="h-weak">最近 30 天最常改的地方</h2>
    <ul class="bars">
      ${weak.map(([t, c]) => `
      <li class="bar">
        <span>${esc(t)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((c / max) * 100)}%; display:block"></span></span>
        <span class="bar-n">${c}</span>
      </li>`).join('')}
    </ul>
  </section>` : ''}

  <section aria-label="所有日記">${list}</section>`;
}

/* ---------- 畫面：設定 ---------- */

let installPrompt = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function viewSettings() {
  const s = state.settings;
  return `
  <header class="page-head"><div><h1>設定</h1></div></header>

  <section class="settings-group" aria-labelledby="h-ai" style="margin-top:0">
    <h2 id="h-ai">AI 批改</h2>
    <div class="field">
      <label for="api-key">Gemini API 金鑰</label>
      <div class="key-row">
        <input id="api-key" class="input" data-setting="apiKey" type="${state.showKey ? 'text' : 'password'}"
          autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(s.apiKey)}" placeholder="貼上 AIza 開頭的金鑰">
        <button class="btn small" data-action="toggle-key" aria-label="${state.showKey ? '隱藏金鑰' : '顯示金鑰'}">${state.showKey ? '隱藏' : '顯示'}</button>
      </div>
      <p class="help">到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> 免費建立一組金鑰，複製後貼在這裡。</p>
    </div>
    <div class="field">
      <label for="model">模型</label>
      <input id="model" class="input" data-setting="model" list="model-list" autocapitalize="off" spellcheck="false" value="${esc(s.model)}">
      <datalist id="model-list">${MODEL_SUGGESTIONS.map((m) => `<option value="${m}">`).join('')}</datalist>
      <p class="help">預設用便宜又快的 Flash-Lite。模型改名或停用時，在這裡換一個就好。</p>
    </div>
    <div class="btn-row">
      <button class="btn secondary" data-action="test-ai">測試連線</button>
    </div>
    <p class="privacy">金鑰只存在這台裝置的瀏覽器裡。日記內容會傳給 Google Gemini 批改；使用免費額度時，Google 可能會用內容改善模型，正式上架前建議改成付費方案或自建後端。</p>
  </section>

  <section class="settings-group" aria-labelledby="h-voice">
    <h2 id="h-voice">英文朗讀</h2>
    <div class="field">
      <label for="voice-engine">語音方式</label>
      <select id="voice-engine" class="input" data-setting="voiceEngine">
        <option value="kokoro" ${s.voiceEngine !== 'device' ? 'selected' : ''}>自然語音 · Kokoro</option>
        <option value="device" ${s.voiceEngine === 'device' ? 'selected' : ''}>裝置語音 · 輕量備用</option>
      </select>
    </div>
    <div class="choices" role="radiogroup" aria-label="自然語音聲音">
      <label class="choice">
        <input type="radio" name="voice" value="af_heart" data-setting="voice" ${s.voice !== 'am_michael' ? 'checked' : ''} ${s.voiceEngine === 'device' ? 'disabled' : ''}>
        <span><strong>女聲 · Heart</strong><span>溫暖自然的美式英文</span></span>
      </label>
      <label class="choice">
        <input type="radio" name="voice" value="am_michael" data-setting="voice" ${s.voice === 'am_michael' ? 'checked' : ''} ${s.voiceEngine === 'device' ? 'disabled' : ''}>
        <span><strong>男聲 · Michael</strong><span>沉穩清晰的美式英文</span></span>
      </label>
    </div>
    <div class="field">
      <label for="voice-speed">朗讀速度</label>
      <select id="voice-speed" class="input" data-setting="voiceSpeed">
        ${[['0.85', '慢速 · 0.85×'], ['1', '正常 · 1×'], ['1.15', '稍快 · 1.15×']].map(([value, label]) => `<option value="${value}" ${String(s.voiceSpeed) === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <button class="btn secondary" data-action="preview-voice">${ICON.speaker}試聽聲音</button>
    <p class="help">自然語音首次使用需下載約 100 MB 的模型與相關檔案，建議使用 Wi-Fi。下載後由這台裝置產生語音，朗讀文字不會上傳；瀏覽器會盡可能保留模型快取。手機首次準備可能較久。</p>
    <p class="help">聲音與速度會自動儲存，套用到全文、單字與複習卡。裝置語音的音色依系統而定，不提供固定男／女聲。</p>
  </section>

  <section class="settings-group" aria-labelledby="h-level">
    <h2 id="h-level">英文程度</h2>
    <div class="choices" role="radiogroup" aria-labelledby="h-level">
      ${Object.entries(LEVELS).map(([k, v]) => `
      <label class="choice">
        <input type="radio" name="level" value="${k}" data-setting="level" ${s.level === k ? 'checked' : ''}>
        <span><strong>${v.zh}（${k}）</strong><span>${v.desc}</span></span>
      </label>`).join('')}
    </div>
  </section>

  <section class="settings-group" aria-labelledby="h-style">
    <h2 id="h-style">批改方式</h2>
    <div class="choices" role="radiogroup" aria-labelledby="h-style">
      <label class="choice">
        <input type="radio" name="style" value="natural" data-setting="style" ${s.style !== 'fix' ? 'checked' : ''}>
        <span><strong>改得更道地</strong><span>除了錯誤，也把不自然的句子改順</span></span>
      </label>
      <label class="choice">
        <input type="radio" name="style" value="fix" data-setting="style" ${s.style === 'fix' ? 'checked' : ''}>
        <span><strong>只改錯的地方</strong><span>保留自己的寫法，只修正錯誤和中文的部分</span></span>
      </label>
    </div>
  </section>

  ${!isStandalone ? `
  <section class="settings-group" aria-labelledby="h-install">
    <h2 id="h-install">加到手機桌面</h2>
    ${installPrompt ? `<div class="btn-row"><button class="btn primary" data-action="install">安裝到主畫面</button></div>`
      : isIOS ? `<p class="sub">在 Safari 點下方的「分享」，再選「加入主畫面」。</p>`
      : `<p class="sub">用 Chrome 開啟，從選單選「安裝應用程式」或「加到主畫面」。</p>`}
  </section>` : ''}

  <section class="settings-group" aria-labelledby="h-data">
    <h2 id="h-data">資料</h2>
    <p class="sub">${state.entries.length} 篇日記、${state.cards.length} 張複習卡，都只存在這台裝置。換手機前記得先匯出。</p>
    <div class="btn-row">
      <button class="btn secondary" data-action="export">匯出備份</button>
      <button class="btn secondary" data-action="import">匯入備份</button>
      <button class="btn danger" data-action="clear">清除所有資料</button>
    </div>
  </section>

  <p class="version">Inkling ${APP_VERSION}</p>`;
}

/* ---------- 渲染與導覽 ---------- */

const VIEWS = { write: viewWrite, result: viewResult, review: viewReview, journal: viewJournal, settings: viewSettings };

function render() {
  const main = document.getElementById('view');
  main.innerHTML = (VIEWS[state.view] || viewWrite)();
  const tabFor = state.view === 'result' ? state.resultFrom : state.view;
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.tab === tabFor) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  const due = dueCards().length;
  const badge = document.getElementById('due-badge');
  badge.textContent = due ? String(due > 99 ? '99+' : due) : '';
  document.querySelector('[data-tab="review"]').setAttribute('aria-label', due ? `複習，今天有 ${due} 張` : '複習');
}

function go(view) {
  if (view === 'review') state.reviewQueue = null;
  state.view = view;
  render();
  window.scrollTo(0, 0);
  document.getElementById('view').focus({ preventScroll: true });
}

function openEntry(id, from) {
  state.current = id;
  state.resultFrom = from;
  go('result');
}

/* ---------- 動作 ---------- */

async function submit() {
  const text = state.draft.trim();
  if (countWords(text) < 4) {
    state.writeError = '再多寫幾個字吧，一兩句就可以。';
    render();
    return;
  }
  if (!str(state.settings.apiKey)) {
    state.writeError = '先到設定填入 Gemini API 金鑰，才能批改。';
    render();
    return;
  }
  state.busy = true;
  state.writeError = '';
  render();
  try {
    const result = await correctWithAI(text);
    let entry = state.editingId ? state.entries.find((e) => e.id === state.editingId) : null;
    if (entry) {
      entry.text = text;
      entry.result = result;
      entry.updated = Date.now();
    } else {
      entry = { id: uid(), date: dayStr(), created: Date.now(), text, result };
      state.entries.push(entry);
    }
    saveEntries();
    state.autoAdded = { id: entry.id, n: autoAddCards(entry) };
    state.draft = '';
    save(KEYS.draft, '');
    state.editingId = null;
    state.busy = false;
    openEntry(entry.id, 'write');
    return;
  } catch (err) {
    state.writeError = err.userMessage || `批改失敗：${err.message}`;
  }
  state.busy = false;
  render();
}

function toggleCard(kind, i) {
  const entry = currentEntry();
  if (!entry || entry.id === 'demo') return;
  const card = kind === 'word' ? wordCard(entry.result.vocab[i], entry.id) : fixCard(entry.result.changes[i], entry.id);
  if (hasCard(card.key)) { removeCard(card.key); toast('已從複習移除'); }
  else { addCard(card); toast('已加入複習'); }
  saveCards();
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function speak(text) {
  return InklingVoice.speak(text, state.settings);
}

function exportData() {
  const data = { app: 'inkling', version: APP_VERSION, exported: new Date().toISOString(), entries: state.entries, cards: state.cards };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inkling-backup-${dayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('已匯出備份');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'inkling') throw new Error('not inkling');
      const ids = new Set(state.entries.map((e) => e.id));
      const keys = new Set(state.cards.map((c) => c.key));
      let ne = 0;
      let nc = 0;
      for (const e of arr(data.entries)) if (e && e.id && e.date && !ids.has(e.id)) { state.entries.push(e); ne++; }
      for (const c of arr(data.cards)) if (c && c.key && !keys.has(c.key)) { state.cards.push(c); nc++; }
      saveEntries();
      saveCards();
      render();
      toast(`匯入了 ${ne} 篇日記、${nc} 張卡片`);
    } catch (e) {
      toast('這個檔案不是 Inkling 的備份');
    }
  };
  reader.readAsText(file);
}

async function testAI() {
  try {
    await callGemini({ user: 'Reply with the single word OK.' });
    toast('連線成功，可以開始批改了');
  } catch (e) {
    toast(e.userMessage || e.message);
  }
}

/* ---------- 事件 ---------- */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;

  switch (a) {
    case 'tab':
      if (el.dataset.tab === 'write' && state.view === 'write') return;
      go(el.dataset.tab);
      break;
    case 'next-prompt':
      state.promptOffset += 1;
      render();
      break;
    case 'submit':
      if (!state.busy) submit();
      break;
    case 'demo':
      state.autoAdded = null;
      openEntry('demo', 'write');
      break;
    case 'open-entry':
      state.autoAdded = null;
      openEntry(el.dataset.id, state.view === 'journal' ? 'journal' : 'write');
      break;
    case 'back':
      go(state.resultFrom);
      break;
    case 'jump': {
      const target = document.getElementById(`chg-${el.dataset.i}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
      break;
    }
    case 'toggle-card':
      toggleCard(el.dataset.kind, Number(el.dataset.i));
      break;
    case 'stop-voice':
      InklingVoice.stop();
      break;
    case 'preview-voice':
      speak('Today was a lovely day. I took a short walk and learned something new.');
      break;
    case 'speak':
      speak(el.dataset.text);
      break;
    case 'speak-corrected': {
      const e = currentEntry();
      if (e) speak(e.result.corrected);
      break;
    }
    case 'go-review':
      go('review');
      break;
    case 'revise': {
      const e = currentEntry();
      if (!e) return;
      state.draft = e.text;
      state.editingId = e.id;
      state.writeError = '';
      go('write');
      break;
    }
    case 'cancel-edit':
      state.editingId = null;
      state.draft = '';
      save(KEYS.draft, '');
      render();
      break;
    case 'delete-entry': {
      const e = currentEntry();
      if (!e || !confirm('刪除這篇日記？從這篇加入的複習卡會保留。')) return;
      state.entries = state.entries.filter((x) => x.id !== e.id);
      saveEntries();
      toast('已刪除這篇日記');
      go('journal');
      break;
    }
    case 'reveal':
      state.reviewShown = true;
      render();
      break;
    case 'grade':
      gradeCard(el.dataset.g);
      render();
      break;
    case 'toggle-key':
      state.showKey = !state.showKey;
      render();
      break;
    case 'test-ai':
      testAI();
      break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.finally(() => { installPrompt = null; render(); });
      }
      break;
    case 'export':
      exportData();
      break;
    case 'import':
      document.getElementById('import-file').click();
      break;
    case 'clear':
      if (!confirm('清除所有日記、複習卡和設定？這個動作無法復原，建議先匯出備份。')) return;
      Object.values(KEYS).forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } });
      state.entries = [];
      state.cards = [];
      state.settings = { ...DEFAULT_SETTINGS };
      state.draft = '';
      toast('已清除所有資料');
      go('write');
      break;
    default:
      break;
  }
});

// 修改標示也能用鍵盤操作
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('.fix-span')) {
    ev.preventDefault();
    ev.target.click();
  }
  if (ev.target.id === 'entry' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (!state.busy) submit();
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'entry') {
    state.draft = ev.target.value;
    saveDraftSoon();
    const c = document.getElementById('count');
    if (c) c.textContent = `${countWords(state.draft)} 字`;
    if (state.writeError) {
      state.writeError = '';
      const err = document.getElementById('write-error');
      if (err) err.textContent = '';
    }
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'import-file') {
    if (el.files && el.files[0]) importData(el.files[0]);
    el.value = '';
    return;
  }
  const key = el.dataset && el.dataset.setting;
  if (!key) return;
  state.settings[key] = el.type === 'radio' ? el.value : el.value.trim();
  if (key === 'model' && !state.settings.model) state.settings.model = DEFAULT_SETTINGS.model;
  if (['voice', 'voiceEngine', 'voiceSpeed'].includes(key)) InklingVoice.stop();
  saveSettings();
  toast('已儲存');
  if (key === 'apiKey' || key === 'model') return;
  render();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (state.view === 'settings') render();
});

// 跨過午夜回到 app 時，更新日期與題目
let renderedDay = dayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state.busy) return;
  if (dayStr() === renderedDay) return;
  renderedDay = dayStr();
  state.reviewQueue = null;
  if (state.view !== 'result') render();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 離線功能無法啟用，不影響使用 */ });
  });
}

render();
