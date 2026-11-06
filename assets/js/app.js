/* ==========================================================================
   四渡赤水 · 1935 — 沙盘、时间轴与事件
   全部数据本地化；Three.js 本地引入
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rad = (d) => (d * Math.PI) / 180;
  const DAY0 = Date.UTC(1935, 0, 19);
  const DAYS = 71;

  const dayOf = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - DAY0) / 86400000);
  const isoOf = (d) => {
    const t = new Date(DAY0 + d * 86400000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return { iso: y + '-' + m + '-' + dd, label: y + '.' + m + '.' + dd, month: t.getUTCMonth() + 1 };
  };

  /* ---------------- 数据 ---------------- */
  const DEM = window.CHISHUI_DEM;
  const RIVER = window.CHISHUI_RIVER;
  const STORY = window.CHISHUI_STORY;
  const SOURCES = window.CHISHUI_SOURCES;

  const W = DEM.bbox[0], S = DEM.bbox[1], E = DEM.bbox[2], N = DEM.bbox[3];
  const NX = DEM.nx, NZ = DEM.nz;
  const heights = new Float32Array(NX * NZ);
  (function decode() {
    const bin = atob(DEM.data);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < NX * NZ; i++) heights[i] = dv.getInt16(i * 2, true);

    // 平滑去采样噪点，保留脊线与沟谷（5 抽头高斯，横纵两遍）
    const tmp = new Float32Array(NX * NZ);
    const ker = [1, 4, 6, 4, 1];
    for (let pass = 0; pass < 2; pass++) {
      for (let z = 0; z < NZ; z++) {
        for (let x = 0; x < NX; x++) {
          let s = 0, w = 0;
          for (let k = -2; k <= 2; k++) {
            const xx = clamp(x + k, 0, NX - 1);
            s += heights[z * NX + xx] * ker[k + 2]; w += ker[k + 2];
          }
          tmp[z * NX + x] = s / w;
        }
      }
      for (let x = 0; x < NX; x++) {
        for (let z = 0; z < NZ; z++) {
          let s = 0, w = 0;
          for (let k = -2; k <= 2; k++) {
            const zz = clamp(z + k, 0, NZ - 1);
            s += tmp[zz * NX + x] * ker[k + 2]; w += ker[k + 2];
          }
          heights[z * NX + x] = s / w;
        }
      }
    }

    // 轻量锐化：把被高斯平滑抹平的山脊补回来一点，保持等高线的锐度
    const base = Float32Array.from(heights);
    for (let z = 1; z < NZ - 1; z++) {
      for (let x = 1; x < NX - 1; x++) {
        const i = z * NX + x;
        const avg = (base[i - 1] + base[i + 1] + base[i - NX] + base[i + NX]) * 0.25;
        heights[i] = base[i] + (base[i] - avg) * 0.3;
      }
    }
  })();

  const CLON = 106.08, CLAT = 27.62;
  const COSLAT = Math.cos(rad(CLAT));
  const WORLD_W = 56;
  const K = WORLD_W / ((E - W) * COSLAT);
  const H0 = 240;
  const VS = 0.0027;

  const toX = (lon) => (lon - CLON) * COSLAT * K;
  const toZ = (lat) => -(lat - CLAT) * K;
  const lonAt = (x) => x / (COSLAT * K) + CLON;
  const latAt = (z) => -z / K + CLAT;

  function demAt(lon, lat) {
    const fx = ((lon - W) / (E - W)) * (NX - 1);
    const fz = ((N - lat) / (N - S)) * (NZ - 1);
    const x = clamp(fx, 0, NX - 1), z = clamp(fz, 0, NZ - 1);
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const x1 = Math.min(x0 + 1, NX - 1), z1 = Math.min(z0 + 1, NZ - 1);
    const tx = x - x0, tz = z - z0;
    const h00 = heights[z0 * NX + x0], h10 = heights[z0 * NX + x1];
    const h01 = heights[z1 * NX + x0], h11 = heights[z1 * NX + x1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  const terrainY = (lon, lat) => (demAt(lon, lat) - H0) * VS;
  const worldPos = (lon, lat, off) =>
    new THREE.Vector3(toX(lon), terrainY(lon, lat) + (off || 0), toZ(lat));

  /* ---------------- 事件/路线预处理 ---------------- */
  const events = STORY.events.map((e) => Object.assign({}, e, { day: dayOf(e.date) }))
    .sort((a, b) => a.day - b.day);
  const crossings = STORY.crossings.map((c) => ({
    ...c,
    day0: Math.min(...c.stages.map((s) => s.d0)),
    day1: Math.max(...c.stages.map((s) => s.d1))
  }));

  const DAY0STATE = { day: 0, playing: false, mode: 'oblique', enemies: false, ferryCard: null };

  /* ======================================================================
     UI：时间轴、事件条、来源
     ====================================================================== */
  const tlTrack = $('#tlTrack');
  const tlFill = $('#tlFill');
  const tlKnob = $('#tlKnob');
  const tlTicks = $('#tlTicks');
  const tlEvents = $('#tlEvents');
  const eventStrip = $('#eventStrip');
  const dateBig = $('#dateBig');
  const phaseText = $('#phaseText');
  const stampMonth = $('#stampMonth');
  const panelKind = $('#panelKind');
  const panelDate = $('#panelDate');
  const panelTitle = $('#panelTitle');
  const panelBody = $('#panelBody');
  const panelMeta = $('#panelMeta');
  const panelNote = $('#panelNote');
  const panelClose = $('#panelClose');
  const playBtn = $('#playBtn');

  (function buildTicks() {
    for (let d = 0; d <= DAYS; d += 7) {
      const i = document.createElement('i');
      i.style.left = (d / DAYS) * 100 + '%';
      tlTicks.appendChild(i);
    }
    events.forEach((e) => {
      const b = document.createElement('button');
      b.style.left = (e.day / DAYS) * 100 + '%';
      b.title = e.dateLabel + ' ' + e.title;
      b.dataset.id = e.id;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        jumpToEvent(e);
      });
      tlEvents.appendChild(b);
    });
  })();

  (function buildChips() {
    events.forEach((e) => {
      const b = document.createElement('button');
      b.className = 'ev-chip';
      b.dataset.id = e.id;
      b.innerHTML = '<b>' + e.dateLabel + '</b><span>' + e.title + '</span>';
      b.addEventListener('click', () => jumpToEvent(e));
      eventStrip.appendChild(b);
    });
  })();

  (function buildSources() {
    const ul = $('#sourceList');
    SOURCES.forEach((s) => {
      const li = document.createElement('li');
      const a = '<a href="' + s.url + '" target="_blank" rel="noopener">' + s.url.replace(/^https?:\/\//, '') + '</a>';
      li.innerHTML = '<b>' + s.label + '</b><span>' + s.text + '<br>' + a + '</span><em>' + s.license + '</em>';
      ul.appendChild(li);
    });
  })();

  /* ---------------- 旁白与语音解说 ---------------- */
  const NARR_ITEMS = (window.CHISHUI_NARRATION && window.CHISHUI_NARRATION.items) || [];
  const NARR_MAP = {};
  NARR_ITEMS.forEach((n) => { NARR_MAP[n.id] = n; });

  const narrEl = $('#narration');
  const narrText = $('#narrText');
  const narrClose = $('#narrClose');
  const narrNote = $('#narrNote');
  const narrToggle = $('#narrToggle');
  const narrCollapse = $('#narrCollapse');
  const narrBody = $('#narrBody');
  const narrSpeakBtn = $('#narrSpeak');
  const narrStopBtn = $('#narrStop');
  const narrRate = $('#narrRate');
  const narrVol = $('#narrVol');
  const narrPace = $('#narrPace');
  const synth = window.speechSynthesis || null;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ } }
  };

  /* 节奏档位：只调整停顿，不再改语速（避免与语速档位相乘） */
  const PACES = {
    calm: { label: '舒缓', dwell: 1.8 },
    normal: { label: '标准', dwell: 1.5 },
    tight: { label: '紧凑', dwell: 1.2 }
  };
  let paceKey = store.get('cs_narr_pace', 'normal');
  if (!PACES[paceKey]) paceKey = 'normal';
  const paceOf = () => PACES[paceKey] || PACES.normal;

  // 语速档位：档位值即有效 rate，默认 1.0 = 实际 1.0，不叠加任何隐藏系数
  const RATE_PRESETS = [0.8, 0.9, 1, 1.25, 1.5, 2];
  const BASE_CPS = 4.45; // 中文基准约 4.45 字/秒（rate=1）
  const parseRate = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return 1;
    return RATE_PRESETS.reduce((best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best), 1);
  };
  const effRate = () => clamp(narrRateVal, RATE_PRESETS[0], RATE_PRESETS[RATE_PRESETS.length - 1]);
  function estSec(id) {
    const item = NARR_MAP[id];
    if (!item) return 8;
    if (typeof item.duration === 'number' && item.duration > 0) return item.duration;
    // 段时长与语速成反比：2 倍速时约为一半，保证档位线性
    return Math.max(2, item.text.length / (BASE_CPS * effRate()));
  }

  let narrOn = store.get('cs_narr_on', '1') !== '0';
  let narrRateVal = parseRate(store.get('cs_narr_rate', '1'));
  let narrVolVal = parseFloat(store.get('cs_narr_vol', '1'));
  if (!isFinite(narrVolVal)) narrVolVal = 1;
  let currentNarrId = 'open';
  let narrSpeaking = false;
  let introShown = false;
  let zhVoice = null;   // 当前选中的声音（可能是云健，也可能是系统声音）
  let noVoice = false;  // 完全没有可用声音时才降级为文字
  let voicePick = { tier: 0, name: '', lang: '', localService: false };
  let utter = null;
  let narrAudio = null;

  // 只认云健（YunJian）这一条网络声音：忽略大小写、空格与括号内容
  const isYunJian = (v) => {
    const name = (v.name || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, '');
    return name.indexOf('yunjian') >= 0 || name.indexOf('云健') >= 0;
  };

  const isZh = (v) => /^zh/i.test(v.lang || '');
  const ZH_ORDER = ['zh-cn', 'zh-sg', 'zh-tw', 'zh-hk'];
  const zhRank = (v) => {
    const l = (v.lang || '').toLowerCase().replace('_', '-');
    const i = ZH_ORDER.indexOf(l);
    return i < 0 ? ZH_ORDER.length : i;
  };
  // 常见系统中文声音名（婷婷 / Ting-Ting / 美嘉 等）
  const COMMON_ZH_NAME = /婷婷|ting-?ting|美嘉|mei-?jia|小燕|xiaoyan/i;

  // 三级优先级：云健 → 系统中文默认 → 任意中文 → 浏览器默认（允许非中文）
  function pickVoice(vs) {
    const yj = vs.find(isYunJian);
    if (yj) return { voice: yj, tier: 1 };
    const zh = vs.filter(isZh).sort((a, b) => zhRank(a) - zhRank(b));
    const defZh = zh.find((v) => v.default === true);
    if (defZh) return { voice: defZh, tier: 2 };
    const common = zh.find((v) => v.localService === true && COMMON_ZH_NAME.test(v.name || ''));
    if (common) return { voice: common, tier: 2 };
    if (zh.length) return { voice: zh[0], tier: 3 };
    const def = vs.find((v) => v.default === true) || vs[0];
    return def ? { voice: def, tier: 4 } : null;
  }

  function syncNarrDebug() {
    if (window.__CS_DEBUG) {
      window.__csNarr = { rate: effRate(), noVoice, voice: voicePick };
    }
  }

  function updateNarrControls() {
    narrToggle.textContent = narrOn ? '解说 开' : '解说 关';
    narrToggle.setAttribute('aria-pressed', String(narrOn));
    narrSpeakBtn.disabled = noVoice;
    narrStopBtn.disabled = noVoice;
    narrNote.hidden = !noVoice;
    if (noVoice) narrNote.textContent = '当前系统未提供可用语音，已降级为文字解说。';
    syncNarrDebug();
  }

  function refreshVoices() {
    if (!synth) {
      zhVoice = null;
      noVoice = true;
      updateNarrControls();
      return;
    }
    const vs = synth.getVoices();
    if (!vs.length) return; // 首次可能为空，等 voiceschanged
    const pick = pickVoice(vs);
    zhVoice = pick ? pick.voice : null;
    noVoice = !zhVoice;
    voicePick = pick
      ? { tier: pick.tier, name: pick.voice.name, lang: pick.voice.lang, localService: !!pick.voice.localService }
      : { tier: 0, name: '', lang: '', localService: false };
    updateNarrControls();
  }

  if (synth) {
    refreshVoices();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', refreshVoices);
    setTimeout(() => {
      refreshVoices();
      if (!synth.getVoices().length) {
        zhVoice = null;
        noVoice = true;
        updateNarrControls();
      }
    }, 1800);
  } else {
    noVoice = true;
  }

  function markSpeaking(on) {
    narrSpeaking = on;
    panel.classList.toggle('speaking', on);
    $$('.ev-chip').forEach((c) => c.classList.remove('speaking'));
    $$('.lbl.ferry').forEach((c) => c.classList.remove('speaking'));
    if (!on) return;
    const chip = $('.ev-chip[data-id="' + currentNarrId + '"]');
    if (chip) chip.classList.add('speaking');
    if (/^c[1-4]$/.test(currentNarrId)) {
      const cross = STORY.crossings.find((c) => c.id === currentNarrId);
      const tag = cross ? ['一渡', '二渡', '三渡', '四渡'][cross.no - 1] : '';
      $$('.lbl.ferry').forEach((el) => {
        if (tag && (el.dataset.crossings || '').indexOf(tag) >= 0) el.classList.add('speaking');
      });
    }
  }

  let narrToken = 0;
  function stopNarration() {
    narrToken++;
    if (synth) synth.cancel();
    if (narrAudio) {
      try { narrAudio.pause(); narrAudio.currentTime = 0; } catch (e) { /* 忽略 */ }
      narrAudio = null;
    }
    utter = null;
    markSpeaking(false);
  }

  function showNarr(id, extraClose) {
    const item = NARR_MAP[id];
    if (!item) return;
    currentNarrId = id;
    if (narrText.textContent !== item.text) {
      narrText.textContent = item.text;
      narrText.classList.remove('fade');
      void narrText.offsetWidth;
      narrText.classList.add('fade');
    }
    if (extraClose && NARR_MAP[extraClose]) {
      narrClose.textContent = NARR_MAP[extraClose].text;
      narrClose.hidden = false;
    } else {
      narrClose.hidden = true;
      narrClose.textContent = '';
    }
  }

  // 朗读单条；onVoiceEnd 在语音结束/失败时回调，供播放推进使用
  function speakItem(id, onVoiceEnd) {
    stopNarration();
    const token = narrToken;
    const item = NARR_MAP[id];
    if (!item) { if (onVoiceEnd) onVoiceEnd(); return; }
    currentNarrId = id;
    markSpeaking(true);
    const done = () => { if (token !== narrToken) return; if (onVoiceEnd) onVoiceEnd(); };
    if (item.audioSrc) {
      narrAudio = new Audio(item.audioSrc);
      narrAudio.volume = narrVolVal;
      narrAudio.onended = () => { if (token !== narrToken) return; markSpeaking(false); done(); };
      narrAudio.onerror = () => { if (token !== narrToken) return; markSpeaking(false); done(); };
      narrAudio.play().catch(() => { if (token !== narrToken) return; markSpeaking(false); done(); });
      return;
    }
    if (!synth || noVoice) {
      markSpeaking(false);
      return;
    }
    utter = new SpeechSynthesisUtterance(item.text);
    utter.lang = (zhVoice && zhVoice.lang) || 'zh-CN';
    if (zhVoice) utter.voice = zhVoice;
    utter.rate = effRate();
    // 云健保持原声，系统回退声音略压暗一点更自然
    utter.pitch = isYunJian(zhVoice || {}) ? 1.0 : 0.98;
    utter.volume = narrVolVal;
    utter.onend = () => { if (token !== narrToken) return; markSpeaking(false); done(); };
    utter.onerror = (e) => {
      if (token !== narrToken) return;
      markSpeaking(false);
      if (e && /language|voice/i.test(e.error || '')) {
        noVoice = true;
        updateNarrControls();
      }
      done();
    };
    // 语音可能被浏览器策略拒绝：静默降级为文字，不抛错、不阻塞推进
    try {
      if (synth.paused) synth.resume();
      synth.speak(utter);
    } catch (err) {
      markSpeaking(false);
      done();
    }
  }

  function speakCurrent() { speakItem(currentNarrId); }

  // 自动播报：仅时间轴播放推进到新事件、或用户主动点选事件时调用
  function narrEvent(ev, force) {
    if (!ev) return;
    const changed = currentNarrId !== ev.id;
    if (!changed && !force) return;
    showNarr(ev.id);
    if (narrOn) speakCurrent();
  }

  function narrChapter(crossId, force) {
    const item = NARR_MAP[crossId];
    if (!item) return;
    if (currentNarrId === crossId && !force) return;
    showNarr(crossId);
    if (narrOn) speakCurrent();
  }

  function narrEnter(silent) {
    if (!introShown) {
      introShown = true;
      showNarr('open');
      if (narrOn && !silent) speakCurrent();
      return;
    }
    // 再次进入只同步文字，不自动重播已播段落
    showNarr(currentNarrId);
  }

  function narrEnd() {
    showNarr('tail', 'close');
    if (narrOn) speakCurrent();
  }

  narrToggle.addEventListener('click', () => {
    narrOn = !narrOn;
    store.set('cs_narr_on', narrOn ? '1' : '0');
    updateNarrControls();
    if (narrOn) speakCurrent();
    else { stopNarration(); onNarrationOff(); }
  });

  narrCollapse.addEventListener('click', () => {
    const collapsed = narrEl.classList.toggle('collapsed');
    narrCollapse.textContent = collapsed ? '展开' : '收起';
    narrCollapse.setAttribute('aria-expanded', String(!collapsed));
    narrBody.hidden = collapsed;
  });

  narrSpeakBtn.addEventListener('click', () => speakCurrent());
  narrStopBtn.addEventListener('click', () => {
    if (DAY0STATE.playing) pausePlayback();
    else stopNarration();
  });

  narrPace.value = paceKey;
  narrVol.value = String(narrVolVal);
  narrPace.addEventListener('change', () => {
    paceKey = PACES[narrPace.value] ? narrPace.value : 'normal';
    store.set('cs_narr_pace', paceKey);
    retimeCurrentBeat();
  });

  // 语速分段控件：按钮值即有效 rate
  const rateBtns = $$('.rate-seg');
  function syncRateUI() {
    rateBtns.forEach((b) => {
      const on = Math.abs(parseFloat(b.dataset.rate) - narrRateVal) < 1e-6;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    syncNarrDebug();
  }
  syncRateUI();
  narrRate.addEventListener('click', (e) => {
    const btn = e.target.closest('.rate-seg');
    if (!btn) return;
    const v = parseFloat(btn.dataset.rate);
    if (!isFinite(v) || v === narrRateVal) return;
    narrRateVal = v;
    store.set('cs_narr_rate', String(v));
    syncRateUI();
    // 正在播报时以新速率重播当前条；否则只重排本段时长
    retimeCurrentBeat(true);
  });
  narrVol.addEventListener('input', () => {
    narrVolVal = parseFloat(narrVol.value);
    if (!isFinite(narrVolVal)) narrVolVal = 1;
    store.set('cs_narr_vol', String(narrVolVal));
  });

  // 节奏/语速变化后按新参数重排当前节拍的时间；换档时按新速率重播当前条
  function retimeCurrentBeat(replay) {
    const ps = playState;
    if (!ps || ps.finished) return;
    ps.dwellMs = paceOf().dwell * 1000;
    if (ps.phase === 'move') {
      const p = clamp((performance.now() - ps.moveStart) / ps.moveMs, 0, 1);
      const total = Math.max(4000, itemSeconds(ps.beat.narrs) * 0.95 * 1000);
      ps.moveMs = total;
      ps.moveStart = performance.now() - p * total;
    }
    if (replay && DAY0STATE.playing) startBeatItem(ps.narrIdx);
  }

  showNarr('open');
  updateNarrControls();

  function currentEvent(day) {
    let cur = null;
    for (const e of events) if (e.day <= day + 0.001) cur = e;
    return cur || events[0];
  }

  function jumpToEvent(e) {
    // 点击节点/事件卡：立即暂停并停止语音，只同步文字
    pauseForInspect();
    setDay(e.day, true);
    showEventCard(e);
    highlightAt(e.lon, e.lat, true);
    showNarr(e.id);
  }

  // 用户点选节点、事件卡、渡口卡时统一走这里：停画面、停语音、按钮回到“播放”
  function pauseForInspect() {
    clearTimeout(autoPlayTimer);
    if (DAY0STATE.playing) pausePlayback();
    else stopNarration();
    playState = null; // 之后必须手动点播放，才从当前节点重新起一段
  }

  function setActiveChip(id) {
    $$('.ev-chip').forEach((c) => c.classList.toggle('on', c.dataset.id === id));
    $$('#tlEvents button').forEach((b) => b.classList.toggle('lit', b.dataset.id === id));
  }

  let lastLabel = '';
  let lastEventId = '';
  function updateUI(day) {
    const d = Math.min(day, DAYS);
    const { label, month } = isoOf(Math.round(d));
    if (label !== lastLabel) {
      lastLabel = label;
      dateBig.textContent = label;
      stampMonth.textContent = ['', '一月', '二月', '三月'][month] || '';
      tlKnob.setAttribute('aria-valuenow', String(Math.round(d)));
      tlKnob.setAttribute('aria-valuetext', label);
    }
    tlFill.style.width = (d / DAYS) * 100 + '%';
    tlKnob.style.left = (d / DAYS) * 100 + '%';

    const ev = currentEvent(d);
    phaseText.textContent = ev ? ev.title : '由遵义地区北上';
    setActiveChip(ev ? ev.id : '');
    if (!DAY0STATE.ferryCard && ev && ev.id !== lastEventId) showEventCard(ev, true);
  }

  function showEventCard(e, silent) {
    if (!e) return;
    lastEventId = e.id;
    panelKind.textContent = '行军解读';
    panelDate.textContent = e.dateLabel + ' · ' + e.place;
    panelTitle.textContent = e.title;
    panelBody.textContent = e.what;
    const crossForEvent = { e3: 'c1', e5: 'c2', e11: 'c3', e12: 'c4' };
    const cross = STORY.crossings.find((c) => c.id === crossForEvent[e.id]);
    panelMeta.innerHTML =
      '<div><dt>结果</dt><dd>' + e.effect + '</dd></div>' +
      '<div><dt>因果</dt><dd>' + e.causal + '</dd></div>' +
      (cross ? '<div><dt>为何转</dt><dd>' + cross.why + '</dd></div>' : '');
    panelNote.textContent = e.caution || '';
    panelClose.hidden = true;
    DAY0STATE.ferryCard = null;
    setActiveFerry(null);
    if (threeReady) updateThree(DAY0STATE.day);
    if (!silent) {
      $('.panel').animate(
        [{ opacity: 0.35, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, easing: 'ease-out' }
      );
    }
  }

  function showFerryCard(id) {
    const f = STORY.ferries.find((x) => x.id === id);
    if (!f) return;
    // 点渡口卡：暂停播放并停止语音，文字同步显示
    pauseForInspect();
    DAY0STATE.ferryCard = id;
    panelKind.textContent = '渡口战况';
    panelDate.textContent = f.date;
    panelTitle.textContent = f.name + ' · ' + f.crossings.join(' / ');
    panelBody.textContent = f.decision;
    panelMeta.innerHTML =
      '<div><dt>部队</dt><dd>' + f.army + '</dd></div>' +
      '<div><dt>敌情</dt><dd>' + f.enemy + '</dd></div>' +
      '<div><dt>渡河</dt><dd>' + f.date + '</dd></div>';
    panelNote.textContent = f.caution || (f.certain ? '' : '部队与日期细节待核。');
    panelClose.hidden = false;
    setActiveFerry(id);
    highlightAt(f.lon, f.lat, false);
    let tag = f.crossings[0];
    if (tag === '二渡' || tag === '四渡') tag = DAY0STATE.day >= 60 ? '四渡' : '二渡';
    const chapter = { 一渡: 'c1', 二渡: 'c2', 三渡: 'c3', 四渡: 'c4' }[tag];
    if (chapter) showNarr(chapter);
    else showNarr('e13');
  }

  panelClose.addEventListener('click', () => {
    DAY0STATE.ferryCard = null;
    const ev = currentEvent(DAY0STATE.day);
    showEventCard(ev);
    showNarr(ev.id);
  });

  /* ---------------- 时间轴拖动 ---------------- */
  let dragging = false;

  function dayFromPointer(clientX) {
    const r = tlTrack.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * DAYS, 0, DAYS);
  }

  function startDrag(e) {
    dragging = true;
    pauseForInspect();
    tlKnob.style.cursor = 'grabbing';
    setDay(dayFromPointer(e.clientX));
    e.preventDefault();
  }

  tlTrack.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#tlEvents button')) return;
    tlTrack.setPointerCapture(e.pointerId);
    startDrag(e);
  });

  tlTrack.addEventListener('pointermove', (e) => {
    if (dragging) setDay(dayFromPointer(e.clientX));
  });

  const endDrag = () => { dragging = false; tlKnob.style.cursor = 'grab'; };
  tlTrack.addEventListener('pointerup', endDrag);
  tlTrack.addEventListener('pointercancel', endDrag);
  tlTrack.addEventListener('lostpointercapture', endDrag);

  tlKnob.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { pausePlayback(); playState = null; setDay(DAY0STATE.day - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { pausePlayback(); playState = null; setDay(DAY0STATE.day + 1); e.preventDefault(); }
  });

  /* ---------------- 播放：解说驱动推进 ----------------
     每个节拍 = 一条或一组解说（章节总述 + 同一天的事件卡）。
     画面在“该组解说估算时长 × 0.9”内走完这一段，随后等待语音真正 onend，
     再按节奏档位停顿 1.2–1.8 秒，才进入下一节拍。 */
  let rafId = null;
  let playState = null;
  let autoPlayTimer = null;

  const chapterForEvent = { e3: 'c1', e5: 'c2', e11: 'c3', e12: 'c4' };
  const BEATS = (function buildBeats() {
    const list = [];
    function push(day, narrs, label, eventId) {
      const last = list[list.length - 1];
      if (last && Math.abs(last.day - day) < 0.001) {
        last.narrs = last.narrs.concat(narrs);
        if (label) last.label += ' / ' + label;
        if (eventId) last.eventId = eventId;
        return;
      }
      list.push({ day, narrs, label: label || '', eventId: eventId || null });
    }
    push(0, ['open'], '开篇');
    events.forEach((ev) => {
      const ch = chapterForEvent[ev.id];
      push(ev.day, ch ? [ch, ev.id] : [ev.id], ev.title, ev.id);
    });
    push(DAYS, ['tail', 'close'], '尾声');
    return list;
  })();

  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

  function beatForDay(day) {
    // 从当前日期向后找最近的节拍，避免拖到中途后按播放出现大幅回跳
    for (let i = 0; i < BEATS.length; i++) {
      if (BEATS[i].day >= day - 0.001) return i;
    }
    return BEATS.length - 1;
  }

  function clearBeatTimers() {
    if (!playState) return;
    if (playState.itemTimer) clearTimeout(playState.itemTimer);
    if (playState.guardTimer) clearTimeout(playState.guardTimer);
    if (playState.startWatch) clearTimeout(playState.startWatch);
    playState.itemTimer = null;
    playState.guardTimer = null;
    playState.startWatch = null;
  }

  function itemSeconds(ids) {
    return ids.reduce((s, id) => s + estSec(id), 0);
  }

  function beginBeat(i, fromDay) {
    clearBeatTimers();
    stopNarration();
    const beat = BEATS[i];
    const next = BEATS[i + 1];
    const endDay = next ? next.day : DAYS;
    const startDay = typeof fromDay === 'number'
      ? clamp(fromDay, beat.day, Math.max(beat.day, endDay - 0.001))
      : beat.day;
    const estTotal = itemSeconds(beat.narrs);
    const moveMs = endDay > startDay ? Math.max(4000, estTotal * 0.86 * 1000) : 1;
    playState = {
      i,
      beat,
      paused: false,
      finished: false,
      startDay,
      endDay,
      moveMs,
      moveStart: performance.now(),
      moveElapsed: 0,
      phase: endDay > startDay ? 'move' : 'hold',
      narrIdx: 0,
      speechDone: false,
      itemStart: 0,
      itemMs: 0,
      minElapsed: false,
      voiceDone: false,
      itemTimer: null,
      guardTimer: null,
      startWatch: null,
      dwellStart: 0,
      dwellMs: paceOf().dwell * 1000
    };
    setDay(startDay);
    if (beat.eventId) setActiveChip(beat.eventId);
    startBeatItem(0);
  }

  function startBeatItem(k) {
    const ps = playState;
    if (!ps) return;
    clearBeatTimers();
    ps.narrIdx = k;
    if (k >= ps.beat.narrs.length) {
      ps.speechDone = true;
      return;
    }
    const id = ps.beat.narrs[k];
    showNarr(id);
    const shouldSpeak = narrOn && !noVoice && !!NARR_MAP[id];
    const ms = estSec(id) * 1000;
    // 有语音时以 onend 为准，这里只保留 8 秒下限，避免“闪一下就过”
    const minMs = shouldSpeak ? Math.min(8000, ms) : ms;
    ps.itemStart = performance.now();
    ps.itemMs = ms;
    ps.minElapsed = false;
    ps.voiceDone = false;
    ps.itemTimer = setTimeout(() => {
      if (playState !== ps) return;
      ps.minElapsed = true;
      checkBeatItem();
    }, minMs);
    if (shouldSpeak) {
      // onend 不触发时的兜底：估算时长 + 7 秒后强制放行
      ps.guardTimer = setTimeout(() => {
        if (playState !== ps) return;
        ps.voiceDone = true;
        stopNarration();
        checkBeatItem();
      }, ms + 7000);
      // 语音被浏览器拒绝（无手势/策略限制）时，1.5 秒内没有启动就静默降级为文字推进
      if (synth && !NARR_MAP[id].audioSrc) {
        ps.startWatch = setTimeout(() => {
          if (playState !== ps || ps.paused || ps.finished) return;
          if (synth.speaking || synth.pending) return;
          ps.voiceDone = true;
          markSpeaking(false);
          if (ps.guardTimer) clearTimeout(ps.guardTimer);
          ps.guardTimer = null;
          // 改用文字估算时长推进，不再等待 8 秒下限
          if (ps.itemTimer) clearTimeout(ps.itemTimer);
          const left = Math.max(1200, ps.itemMs - (performance.now() - ps.itemStart));
          ps.itemTimer = setTimeout(() => {
            if (playState !== ps) return;
            ps.minElapsed = true;
            checkBeatItem();
          }, left);
        }, 1500);
      }
      speakItem(id, () => {
        if (playState !== ps) return;
        ps.voiceDone = true;
        checkBeatItem();
      });
    } else {
      ps.voiceDone = true; // 解说关闭 / 无中文语音：只用估算时长
    }
  }

  function checkBeatItem() {
    const ps = playState;
    if (!ps || ps.paused || ps.finished) return;
    if (!ps.minElapsed || !ps.voiceDone) return;
    clearBeatTimers();
    if (ps.narrIdx + 1 < ps.beat.narrs.length) {
      const n = ps.narrIdx + 1;
      setTimeout(() => { if (playState === ps) startBeatItem(n); }, 350);
    } else {
      ps.speechDone = true;
    }
  }

  // 解说被手动关闭时，让当前节拍剩 remainder 的估算时长走完，不抢段
  function onNarrationOff() {
    const ps = playState;
    if (!ps || ps.paused || ps.finished || ps.speechDone) return;
    ps.voiceDone = true;
    checkBeatItem();
  }

  function finishPlayback() {
    const ps = playState;
    if (ps) {
      ps.finished = true;
      ps.paused = false;
      ps.dwellStart = 0;
    }
    DAY0STATE.playing = false;
    playBtn.textContent = '重播四渡';
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    setDay(DAYS);
  }

  function playTick(t) {
    if (!DAY0STATE.playing || !playState) return;
    const ps = playState;
    if (ps.phase === 'move') {
      const p = clamp((t - ps.moveStart) / ps.moveMs, 0, 1);
      setDay(ps.startDay + (ps.endDay - ps.startDay) * easeInOut(p));
      if (p >= 1) { ps.phase = 'hold'; ps.dwellStart = 0; }
    } else if (ps.phase === 'hold' && ps.speechDone) {
      if (!ps.dwellStart) ps.dwellStart = performance.now();
      if (performance.now() - ps.dwellStart >= ps.dwellMs) {
        const next = ps.i + 1;
        if (next >= BEATS.length) { finishPlayback(); return; }
        beginBeat(next);
        rafId = requestAnimationFrame(playTick);
        return;
      }
    }
    rafId = requestAnimationFrame(playTick);
  }

  function playPause() {
    if (DAY0STATE.playing) pausePlayback();
    else startPlayback();
  }

  function startPlayback() {
    if (playState && playState.paused && !playState.finished) {
      const ps = playState;
      ps.paused = false;
      ps.moveStart = performance.now() - ps.moveElapsed;
      if (ps.speechDone) ps.dwellStart = performance.now();
      else startBeatItem(ps.narrIdx);
    } else {
      // 从当前时间轴位置起播，进度归零，不回跳
      const idx = (DAY0STATE.day >= DAYS) ? 0 : beatForDay(DAY0STATE.day);
      beginBeat(idx, DAY0STATE.day >= DAYS ? 0 : DAY0STATE.day);
    }
    DAY0STATE.playing = true;
    playBtn.textContent = '暂停';
    rafId = requestAnimationFrame(playTick);
  }

  function pausePlayback() {
    DAY0STATE.playing = false;
    playBtn.textContent = '播放';
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (playState && !playState.finished) {
      playState.paused = true;
      playState.moveElapsed = performance.now() - playState.moveStart;
    }
    clearBeatTimers();
    stopNarration();
  }

  playBtn.addEventListener('click', playPause);
  $('#replayBtn').addEventListener('click', () => {
    playState = null;
    setDay(0);
    startPlayback();
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && /BUTTON|INPUT|A/.indexOf(document.activeElement.tagName) < 0) {
      e.preventDefault();
      playPause();
    }
  });

  /* ======================================================================
     三维场景
     ====================================================================== */
  const stage = $('#sandbox');
  const canvas = $('#scene');
  const labelsBox = $('#labels');
  let renderer = null;
  let scene, camera, clock;
  let camTarget, camTheta, camPhi, camRadius, goalTheta, goalPhi, goalRadius, goalTarget;
  let terrainMesh, riverGroup, arrowGroup, enemyGroup, ferryGroup, highlightRing, cloudGroup;
  let labelItems = [];
  let plaqueEls = [];
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let stageVisible = true;
  let threeReady = false;
  let currentHeads = [];

  /* ---------------- 进入 / 退出沙盘（滚动、历史、ESC） ---------------- */
  const stageExit = $('#stageExit');
  const heroEnter = $('.hero-enter');
  let sandboxReturnY = 0;
  let sandboxEntered = false;
  let pendingHistoryExit = false;

  function stageInView() {
    const r = stage.getBoundingClientRect();
    return r.top < window.innerHeight * 0.55 && r.bottom > window.innerHeight * 0.45;
  }

  // 临时关闭 CSS 平滑滚动，确保退出时精确回到进入前的位置
  function jumpScroll(y) {
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    try {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    } catch (err) {
      window.scrollTo(0, y);
    }
    requestAnimationFrame(() => { root.style.scrollBehavior = prev; });
  }

  function scrollToStage(instant) {
    const y = stage.getBoundingClientRect().top + window.scrollY;
    if (instant) jumpScroll(y);
    else window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function enterSandbox(e) {
    if (e) e.preventDefault();
    sandboxReturnY = window.scrollY;
    sandboxEntered = true;
    if (!(history.state && history.state.sandbox)) {
      history.pushState({ sandbox: true }, '', '#sandbox');
    }
    scrollToStage(false);
    // 解说交给自动播放统一出声，避免开篇被朗读两遍
    narrEnter(true);
    scheduleAutoPlay();
  }

  // 进入沙盘后自动开播：等滚动落位再从当前时间轴位置起播，进度归零
  function scheduleAutoPlay() {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = setTimeout(() => {
      autoPlayTimer = null;
      if (!sandboxEntered || !stageInView() || DAY0STATE.playing) return;
      if (playState && playState.paused) playState = null;
      startPlayback();
    }, 420);
  }

  function restoreOverview() {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
    pausePlayback();
    if (DAY0STATE.ferryCard) {
      DAY0STATE.ferryCard = null;
      showEventCard(currentEvent(DAY0STATE.day), true);
    }
    stageExit.blur();
    jumpScroll(sandboxReturnY);
    sandboxEntered = false;
  }

  function exitSandbox() {
    if (!stageInView() && !sandboxEntered) return;
    if (history.state && history.state.sandbox) {
      pendingHistoryExit = true;
      history.back();
      return;
    }
    if (location.hash === '#sandbox') {
      history.replaceState(null, '', location.pathname + location.search);
    }
    restoreOverview();
  }

  heroEnter.addEventListener('click', enterSandbox);
  stageExit.addEventListener('click', exitSandbox);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (stageInView() || sandboxEntered)) exitSandbox();
  });

  window.addEventListener('popstate', () => {
    if (history.state && history.state.sandbox) {
      pendingHistoryExit = false;
      scrollToStage(true);
      sandboxEntered = true;
      scheduleAutoPlay();
      return;
    }
    if (pendingHistoryExit || sandboxEntered) {
      pendingHistoryExit = false;
      restoreOverview();
    }
  });

  function initThree() {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl');
      if (!gl) return false;
      if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      return false;
    }
    if (!renderer || !renderer.getContext()) return false;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    scene = new THREE.Scene();
    // 暖灰绿空气透视，模拟高空远景的薄雾
    scene.fog = new THREE.FogExp2(0x2d3728, 0.0034);
    clock = new THREE.Clock();

    camera = new THREE.PerspectiveCamera(42, canvas.clientWidth / canvas.clientHeight, 0.1, 320);
    camTarget = new THREE.Vector3(0, 0.6, 4.5);
    camTheta = -0.22;
    camPhi = 0.86;
    camRadius = 104;
    goalTheta = camTheta; goalPhi = camPhi; goalRadius = camRadius; goalTarget = camTarget.clone();

    scene.add(new THREE.AmbientLight(0x5d6f60, 0.34));
    scene.add(new THREE.HemisphereLight(0x93a795, 0x0c120e, 0.36));

    const sun = new THREE.DirectionalLight(0xf6ecd5, 1.12);
    sun.position.set(-34, 46, 20);
    scene.add(sun);

    // 低角度暖光：让山脊西侧出现纪录片式的金边
    const warm = new THREE.DirectionalLight(0xffb877, 0.42);
    warm.position.set(-46, 12, 34);
    scene.add(warm);

    const fill = new THREE.DirectionalLight(0x5c7480, 0.22);
    fill.position.set(30, 20, -26);
    scene.add(fill);

    buildTerrain();
    buildClouds();
    buildBase();
    buildRiver();
    buildFerries();
    buildEnemies();
    buildArrows();
    buildHighlight();
    buildLabels();
    bindControls();

    if (window.__CS_DEBUG) {
      // 仅供自动化走查取景，生产环境不暴露
      window.__csView = () => ({
        target: camTarget.toArray(),
        radius: camRadius,
        theta: camTheta,
        phi: camPhi,
        mode: DAY0STATE.mode
      });
      window.__csFocus = function (no, si, f, radius, theta, phi) {
        const c = crossings.find((x) => x.no === no);
        const s = c && c.stages[si];
        if (!s || !s._pts) return null;
        const idx = clamp(Math.round((s._pts.length - 1) * f), 0, s._pts.length - 1);
        const pt = s._pts[idx];
        DAY0STATE.mode = 'free';
        goalTarget.set(pt.x, pt.y, pt.z);
        camTarget.copy(goalTarget);
        goalRadius = camRadius = radius || 8;
        if (theta != null) { goalTheta = camTheta = theta; }
        if (phi != null) { goalPhi = camPhi = phi; }
        return { x: pt.x, y: pt.y, z: pt.z, segs: s._segs };
      };
    }

    threeReady = true;
    return true;
  }

  /* ---------------- 地形 ---------------- */
  function buildTerrain() {
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    const step = narrow ? 2 : 1;
    const cols = Math.floor((NX - 1) / step) + 1;
    const rows = Math.floor((NZ - 1) / step) + 1;
    const count = cols * rows;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const hs = new Float32Array(count);
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);

    let p = 0;
    for (let r = 0; r < rows; r++) {
      const iz = Math.min(r * step, NZ - 1);
      const lat = N - (iz / (NZ - 1)) * (N - S);
      for (let c = 0; c < cols; c++) {
        const ix = Math.min(c * step, NX - 1);
        const lon = W + (ix / (NX - 1)) * (E - W);
        const h = heights[iz * NX + ix];
        hs[p] = h;
        positions[p * 3] = toX(lon);
        positions[p * 3 + 1] = (h - H0) * VS;
        positions[p * 3 + 2] = toZ(lat);
        p++;
      }
    }

    let t = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices[t++] = a; indices[t++] = d; indices[t++] = b;
        indices[t++] = b; indices[t++] = d; indices[t++] = e;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    const nor = geo.attributes.normal;
    // 取色参照真实卫星地形：谷地草甸偏黄绿、山体森林深绿、裸岩暖褐、最高脊线浅灰米白
    const cValley = new THREE.Color(0x3b5a33);
    const cBank = new THREE.Color(0x4a6330);
    const cMid = new THREE.Color(0x1b3318);
    const cMidHigh = new THREE.Color(0x2b4720);
    const cStone = new THREE.Color(0x7d8064);
    const cRock = new THREE.Color(0x7d6742);
    const cRidge = new THREE.Color(0xbcb083);
    const cSnow = new THREE.Color(0xe4e8da);
    const sunDir = new THREE.Vector3(-0.45, 0.78, 0.32).normalize();
    const n = new THREE.Vector3();
    const col = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const h = hs[i];
      const e = clamp((h - 280) / (1980 - 280), 0, 1);
      n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
      const slope = Math.hypot(n.x, n.z) / Math.max(Math.abs(n.y), 0.06);

      if (e < 0.3) col.copy(cValley).lerp(cBank, e / 0.3);
      else if (e < 0.6) col.copy(cBank).lerp(cMid, (e - 0.3) / 0.3);
      else if (e < 0.84) col.copy(cMid).lerp(cMidHigh, (e - 0.6) / 0.24);
      else col.copy(cMidHigh).lerp(cStone, clamp((e - 0.84) / 0.16, 0, 1));

      // 陡坡露岩：低处偏暖褐，高处偏灰白
      const rock = clamp((slope - 1.35) * 0.72, 0, 1) * (0.15 + 0.34 * smooth(0.5, 0.95, e));
      if (rock > 0) col.lerp(cRock, Math.min(rock, 0.46));

      // 山脊高光：局部凸起
      const iz = Math.min(Math.round(i / cols) * step, NZ - 1);
      const ix = Math.min((i % cols) * step, NX - 1);
      const idx = iz * NX + ix;
      const lap = 4 * heights[idx] -
        (heights[Math.max(idx - 1, 0)] + heights[Math.min(idx + 1, NX * NZ - 1)] +
          heights[Math.max(idx - NX, 0)] + heights[Math.min(idx + NX, NX * NZ - 1)]);
      const ridge = clamp((lap - 2) / 16, 0, 1) * 0.16;
      if (ridge > 0) col.lerp(cRidge, ridge);

      // 最高峰顶的浅色岩盖（参照远景雪线）
      const cap = smooth(0.94, 0.995, e) * smooth(1.6, 2.6, slope);
      if (cap > 0) col.lerp(cSnow, cap * 0.34);

      const shade = 0.66 + Math.max(0, n.dot(sunDir)) * 0.34 + (e - 0.5) * 0.05;
      let noise = Math.sin(idx * 12.9898) * 43758.5453;
      noise = noise - Math.floor(noise);
      col.multiplyScalar(shade * (0.94 + noise * 0.1));

      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: false
    });

    terrainMesh = new THREE.Mesh(geo, mat);
    scene.add(terrainMesh);
  }

  function smooth(a, b, v) {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---------------- 云层 ----------------
     参照纪录片式沙盘：白色积云成团贴在山脊上，少量高空薄云，缓慢漂移。 */
  function cloudTexture(seed) {
    const SZ = 128;
    const c = document.createElement('canvas');
    c.width = c.height = SZ;
    const ctx = c.getContext('2d');
    const rnd = mulberry(seed);
    for (let i = 0; i < 9; i++) {
      const r = SZ * (0.1 + rnd() * 0.16);
      const x = SZ * (0.22 + rnd() * 0.56);
      const y = SZ * (0.34 + rnd() * 0.34);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.16 + rnd() * 0.16;
      g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      g.addColorStop(0.55, 'rgba(252,252,248,' + (a * 0.55).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(250,250,246,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildClouds() {
    cloudGroup = new THREE.Group();
    const rnd = mulberry(20261106);
    const puffs = 22;
    for (let i = 0; i < puffs; i++) {
      const lon = W + (0.1 + rnd() * 0.8) * (E - W);
      const lat = S + (0.1 + rnd() * 0.8) * (N - S);
      const base = terrainY(lon, lat);
      const high = i % 5 === 0;
      const tex = cloudTexture(i * 37 + 11);
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: true,
        opacity: high ? 0.24 + rnd() * 0.12 : 0.34 + rnd() * 0.24,
        color: 0xf6f8f2, fog: true
      });
      const sp = new THREE.Sprite(mat);
      const w = high ? 15 + rnd() * 13 : 8 + rnd() * 10;
      const h = w * (0.34 + rnd() * 0.14);
      sp.scale.set(w, h, 1);
      sp.position.set(toX(lon), base + (high ? 7 + rnd() * 5 : 1.4 + rnd() * 2.4), toZ(lat));
      sp.userData = { x0: sp.position.x, range: 5 + rnd() * 6 };
      cloudGroup.add(sp);
    }
    // 几团压在脊线上的“主角云”，保证全景视角也能读到云的存在
    [[105.72, 28.52, 13], [106.22, 28.60, 15], [106.58, 28.30, 12], [105.96, 27.96, 11]].forEach((c, i) => {
      const mat = new THREE.SpriteMaterial({
        map: cloudTexture(900 + i * 13), transparent: true, depthWrite: false,
        depthTest: true, opacity: 0.55 + i * 0.03, color: 0xfbfcf7, fog: true
      });
      const sp = new THREE.Sprite(mat);
      const w = c[2] + 4;
      sp.scale.set(w, w * 0.44, 1);
      sp.position.set(toX(c[0]), terrainY(c[0], c[1]) + 4.6 + i * 0.7, toZ(c[1]));
      sp.userData = { x0: sp.position.x, range: 3 + i * 1.2 };
      cloudGroup.add(sp);
    });

    cloudGroup.renderOrder = 8;
    scene.add(cloudGroup);
  }

  function buildBase() {
    const depth = (N - S) * K;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_W + 1.6, 1.2, depth + 1.6),
      new THREE.MeshStandardMaterial({ color: 0x0b110d, roughness: 1, metalness: 0 })
    );
    base.position.set(0, -0.75, 0);
    scene.add(base);

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_W + 2.2, 0.12, depth + 2.2),
      new THREE.MeshBasicMaterial({ color: 0x6b5c3c, transparent: true, opacity: 0.28 })
    );
    rim.position.set(0, -1.32, 0);
    scene.add(rim);
  }

  /* ---------------- 河道 ---------------- */
  function surfaceRibbon(points3, halfWidth, offset, samples, across) {
    const curve = new THREE.CatmullRomCurve3(points3, false, 'catmullrom', 0.35);
    const pos = [];
    const idx = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const pt = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      // 取横断面最高地形，保证河面浮于两岸之上，不被山脊遮挡
      let yTop = -Infinity;
      for (let j = 0; j <= across; j++) {
        const s = (j / across) * 2 - 1;
        const wx = pt.x + side.x * s * halfWidth;
        const wz = pt.z + side.z * s * halfWidth;
        yTop = Math.max(yTop, terrainY(lonAt(wx), latAt(wz)));
      }
      yTop += offset;
      for (let j = 0; j <= across; j++) {
        const s = (j / across) * 2 - 1;
        const wx = pt.x + side.x * s * halfWidth;
        const wz = pt.z + side.z * s * halfWidth;
        pos.push(wx, yTop, wz);
      }
    }
    const stride = across + 1;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function buildRiver() {
    riverGroup = new THREE.Group();
    const pts = RIVER.points.map(([lon, lat]) => new THREE.Vector3(toX(lon), 0, toZ(lat)));
    if (pts.length < 4) return;

    const bank = new THREE.Mesh(
      surfaceRibbon(pts, 0.64, 0.3, 180, 4),
      new THREE.MeshStandardMaterial({
        color: 0x2a4b3e, roughness: 0.95, transparent: true, opacity: 0.5,
        depthWrite: false, side: THREE.DoubleSide
      })
    );
    riverGroup.add(bank);

    const shallow = new THREE.Mesh(
      surfaceRibbon(pts, 0.44, 0.34, 200, 5),
      new THREE.MeshStandardMaterial({
        color: 0x6fb9a5, roughness: 0.85, transparent: true, opacity: 0.48,
        depthWrite: false, side: THREE.DoubleSide
      })
    );
    riverGroup.add(shallow);

    const water = new THREE.Mesh(
      surfaceRibbon(pts, 0.28, 0.38, 220, 5),
      new THREE.MeshStandardMaterial({
        color: 0x62bfae, roughness: 0.3, metalness: 0.08,
        emissive: 0x2f7a6c, emissiveIntensity: 0.8,
        side: THREE.DoubleSide
      })
    );
    water.renderOrder = 12;
    riverGroup.add(water);

    const glint = new THREE.Mesh(
      surfaceRibbon(pts, 0.08, 0.42, 220, 3),
      new THREE.MeshBasicMaterial({
        color: 0xd0f2e3, transparent: true, opacity: 0.6, depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    glint.renderOrder = 13;
    riverGroup.add(glint);

    scene.add(riverGroup);
  }

  /* ---------------- 渡口环标 ---------------- */
  const ferryMeshes = [];
  function buildFerries() {
    ferryGroup = new THREE.Group();
    STORY.ferries.forEach((f) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.24, 0.022, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xc9a961, transparent: true, opacity: 0.85 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(worldPos(f.lon, f.lat, 0.3));
      ring.userData.ferry = f.id;
      ferryGroup.add(ring);
      ferryMeshes.push(ring);
    });
    scene.add(ferryGroup);
  }

  /* ---------------- 敌军态势 ---------------- */
  function buildEnemies() {
    enemyGroup = new THREE.Group();
    enemyGroup.visible = false;
    const shape = new THREE.Shape();
    shape.moveTo(-0.42, 0.95);
    shape.lineTo(0.42, 0.95);
    shape.lineTo(0, -0.5);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);

    STORY.enemies.forEach((en) => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x7fa3b3, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(worldPos(en.lon, en.lat, 1.15));
      m.rotation.y = Math.PI - rad(en.dir);
      m.scale.setScalar(2.3);
      enemyGroup.add(m);

      const tailLen = 5.4;
      const dirX = Math.sin(rad(en.dir));
      const dirZ = -Math.cos(rad(en.dir));
      const from = worldPos(en.lon, en.lat, 1.05);
      const to = new THREE.Vector3(from.x + dirX * tailLen, 0, from.z + dirZ * tailLen);
      to.y = terrainY(lonAt(to.x), latAt(to.z)) + 1.05;
      const lg = new THREE.BufferGeometry().setFromPoints([from, to]);
      const line = new THREE.Line(lg, new THREE.LineDashedMaterial({
        color: 0x8fb4c4, transparent: true, opacity: 0.7, dashSize: 0.32, gapSize: 0.2
      }));
      line.computeLineDistances();
      enemyGroup.add(line);
    });
    scene.add(enemyGroup);
  }

  /* ---------------- 红色立体箭头 ----------------
     形制参照手绘毛笔箭头：尾部收窄、中段最宽，截面为圆角刃口；箭镞为宽扁后掠翼、
     中央内凹缺口、边缘倒角。整条箭头仍在同一基准平面内，沿弧长自适应细分。 */
  const ARROW_HALF = 0.42;      // 中段标准半宽
  const ARROW_THICK = 0.30;     // 中轴总厚度
  const HEAD_LEN = 1.66;        // 箭镞长度（沿行进方向）
  const HEAD_SPAN = 2.12;       // 箭镞展宽
  const HEAD_OVERLAP = 0.55;    // 箭身伸入箭镞的重叠量
  const RING = 12;              // 圆角刃口截面顶点数
  let arrowBaseY = 0;

  // 宽度曲线：尾端 0.55 → 中段 1.0 → 近镞 0.94 → 交接 0.76
  // 单调三次样条（Fritsch–Carlson），保证不出现过冲与折线拐点
  const AW = (function makeWidthCurve(keys) {
    const n = keys.length;
    const d = new Array(n);
    d[0] = (keys[1][1] - keys[0][1]) / (keys[1][0] - keys[0][0]);
    d[n - 1] = (keys[n - 1][1] - keys[n - 2][1]) / (keys[n - 1][0] - keys[n - 2][0]);
    for (let i = 1; i < n - 1; i++) {
      d[i] = (keys[i + 1][1] - keys[i - 1][1]) / (keys[i + 1][0] - keys[i - 1][0]);
    }
    for (let i = 0; i < n - 1; i++) {
      const del = (keys[i + 1][1] - keys[i][1]) / (keys[i + 1][0] - keys[i][0]);
      if (Math.abs(del) < 1e-9) { d[i] = 0; d[i + 1] = 0; continue; }
      const a = d[i] / del, b = d[i + 1] / del;
      if (a * a + b * b > 9) {
        const s = 3 / Math.sqrt(a * a + b * b);
        d[i] = s * a * del;
        d[i + 1] = s * b * del;
      }
    }
    return function widthAt(t) {
      const x = clamp(t, 0, 1);
      let i = 0;
      while (i < n - 2 && x > keys[i + 1][0]) i++;
      const h = keys[i + 1][0] - keys[i][0];
      const u = (x - keys[i][0]) / h;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * keys[i][1] +
        (u3 - 2 * u2 + u) * h * d[i] +
        (-2 * u3 + 3 * u2) * keys[i + 1][1] +
        (u3 - u2) * h * d[i + 1];
    };
  })([[0, 0.55], [0.42, 1.0], [0.78, 0.94], [1, 0.76]]);

  // 截面：中部略厚、两侧收薄成刃口的圆角轮廓（上厚下略薄）
  const RING_PROFILE = [
    [0, 1.0], [0.58, 0.93], [0.90, 0.60], [1.0, 0.05],
    [0.90, -0.55], [0.58, -0.80], [0, -0.92],
    [-0.58, -0.80], [-0.90, -0.55], [-1.0, 0.05], [-0.90, 0.60], [-0.58, 0.93]
  ];

  // 统一基准平面：取全部四渡路线样点（含约 ±1.3 km 邻域）的最高地形，再抬升固定值。
  // 箭头只在水平面内转向，不再逐点贴合 DEM，避免上下颠簸。
  function computeArrowBaseY() {
    let maxY = -Infinity;
    crossings.forEach((cross) => {
      cross.stages.forEach((stage) => {
        const v2 = stage.pts.map(([lon, lat]) => new THREE.Vector2(toX(lon), toZ(lat)));
        const spline = new THREE.SplineCurve(v2);
        for (let i = 0; i <= 36; i++) {
          const p = spline.getPoint(i / 36);
          const lon0 = lonAt(p.x), lat0 = latAt(p.y);
          const offsets = [[0, 0], [0.012, 0], [-0.012, 0], [0, 0.012], [0, -0.012]];
          offsets.forEach(([dLon, dLat]) => {
            maxY = Math.max(maxY, terrainY(lon0 + dLon, lat0 + dLat));
          });
        }
      });
    });
    return maxY + 0.32;
  }

  // 磨砂树脂质感：低自发光 + 菲涅尔边缘高光（按视角提亮轮廓）
  function tuneArrowMaterial(mat) {
    mat.customProgramCacheKey = () => 'cs-arrow-rim';
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        'float csRim = pow(clamp(length(cross(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.4);\n' +
        'totalEmissiveRadiance += vec3(0.95, 0.44, 0.30) * csRim * 0.26;'
      );
    };
  }

  // 箭身：12 点圆角刃口截面沿路径放样，索引化后自动得到平滑法线
  function buildArrowShaft(pts, ts) {
    const pos = [];
    const idx = [];
    const segs = pts.length - 1;
    const halfTop = ARROW_THICK * 0.5;
    const halfBot = ARROW_THICK * 0.42;
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i <= segs; i++) {
      const p = pts[i];
      const prev = pts[Math.max(i - 1, 0)];
      const next = pts[Math.min(i + 1, segs)];
      tan.set(next.x - prev.x, 0, next.z - prev.z);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      side.set(-tan.z, 0, tan.x);
      const w = ARROW_HALF * AW(ts[i]);
      // 刃口截面：u 为横向、v 为纵向，两侧收薄到接近零厚度
      for (let j = 0; j < RING; j++) {
        const pr = RING_PROFILE[j];
        const vh = pr[1] >= 0 ? halfTop : halfBot;
        pos.push(p.x + side.x * pr[0] * w, p.y + pr[1] * vh, p.z + side.z * pr[0] * w);
      }
    }

    // 尾端封口（三角扇），避免斜视角看到空心断面
    const cIdx = pos.length / 3;
    pos.push(pts[0].x, pts[0].y, pts[0].z);
    for (let j = 0; j < RING; j++) idx.push(cIdx, j, (j + 1) % RING);

    for (let i = 0; i < segs; i++) {
      const a = i * RING, b = (i + 1) * RING;
      for (let j = 0; j < RING; j++) {
        const j2 = (j + 1) % RING;
        idx.push(a + j, b + j, a + j2, a + j2, b + j, b + j2);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // 校验外法线朝向，必要时整体翻转绕向（防止光照反向）
    if (g.attributes.normal.getY(0) < 0) {
      const arr = g.index.array;
      for (let i = 0; i < arr.length; i += 3) {
        const tmp = arr[i + 1];
        arr[i + 1] = arr[i + 2];
        arr[i + 2] = tmp;
      }
      g.index.needsUpdate = true;
      g.computeVertexNormals();
    }
    g.userData = { segs, cap: RING * 3, idxPerSeg: RING * 6 };
    return g;
  }

  // 描边：沿截面两侧刃口生成两条暗红窄带，贴在最外侧而不覆盖箭身表面。
  // （不用 BackSide 外扩外壳：半透明箭身会把整层外壳透出来，形成暗色横带）
  function buildArrowRim(pts, ts) {
    const pos = [];
    const idx = [];
    const segs = pts.length - 1;
    const yOff = ARROW_THICK * 0.5 * 0.06;
    const inner = 1.0, outer = 1.09;
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let i = 0; i <= segs; i++) {
      const p = pts[i];
      const prev = pts[Math.max(i - 1, 0)];
      const next = pts[Math.min(i + 1, segs)];
      tan.set(next.x - prev.x, 0, next.z - prev.z);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      side.set(-tan.z, 0, tan.x);
      const w = ARROW_HALF * AW(ts[i]);
      [-1, 1].forEach((sgn) => {
        pos.push(p.x + side.x * sgn * w * inner, p.y + yOff, p.z + side.z * sgn * w * inner);
        pos.push(p.x + side.x * sgn * w * outer, p.y + yOff, p.z + side.z * sgn * w * outer);
      });
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 4, b = a + 4;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
      idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.userData = { idxPerSeg: 12, segs };
    return g;
  }

  // 宽扁后掠箭镞：解析轮廓（上缘近直线 + 后掠翼 + 中央内凹缺口），
  // Extrude 倒角沿边缘形成 1–2 圈内缩顶点，得到清晰的高光边。
  function buildArrowHeadGeo() {
    const tipY = -HEAD_LEN * 0.64;
    const wingY = HEAD_LEN * 0.36;
    const halfSpan = HEAD_SPAN * 0.5;
    const sh = new THREE.Shape();
    sh.moveTo(0, tipY);
    // 右翼外缘：近乎直线的轻微外扩
    sh.quadraticCurveTo(halfSpan * 0.47, -0.28, halfSpan, wingY);
    // 翼尖 → 中央缺口：向镞尖方向内凹
    sh.quadraticCurveTo(halfSpan * 0.49, 0.02, 0, 0.10);
    // 左半侧镜像
    sh.quadraticCurveTo(-halfSpan * 0.49, 0.02, -halfSpan, wingY);
    sh.quadraticCurveTo(-halfSpan * 0.47, -0.28, 0, tipY);

    const g = new THREE.ExtrudeGeometry(sh, {
      depth: 0.22, steps: 1, curveSegments: 18,
      bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.06, bevelSegments: 2
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -0.075, 0);
    g.computeVertexNormals();
    return g;
  }

  // 沿弧长采样：间距 ≤0.095，并对弦高误差 >0.5% 路径长的区段继续细分
  function sampleArrow(stage) {
    const v3 = stage.pts.map(([lon, lat]) => new THREE.Vector3(toX(lon), arrowBaseY, toZ(lat)));
    const curve = new THREE.CatmullRomCurve3(v3, false, 'centripetal', 0.5);
    const L = curve.getLength();
    const tol = Math.max(0.006, L * 0.005);
    const base = Math.max(12, Math.ceil(L / 0.095));
    const out = [];
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    const cr = new THREE.Vector3();

    const sagitta = (p0, pm, p1) => {
      ab.subVectors(p1, p0);
      ap.subVectors(pm, p0);
      if (ab.lengthSq() < 1e-10) return pm.distanceTo(p0);
      cr.crossVectors(ab, ap);
      return cr.length() / ab.length();
    };

    function emit(t0, p0, t1, p1, depth) {
      const tm = (t0 + t1) * 0.5;
      const pm = curve.getPoint(tm);
      if (depth < 5 && sagitta(p0, pm, p1) > tol) {
        emit(t0, p0, tm, pm, depth + 1);
        out.push({ t: tm, p: pm });
        emit(tm, pm, t1, p1, depth + 1);
      }
    }

    for (let i = 0; i < base; i++) {
      const t0 = i / base, t1 = (i + 1) / base;
      emit(t0, curve.getPoint(t0), t1, curve.getPoint(t1), 0);
      out.push({ t: t1, p: curve.getPoint(t1) });
    }

    return { curve, pts: out.map((o) => o.p), ts: out.map((o) => o.t), length: L };
  }

  // 贴地阴影：沿路线贴合地形表面、随路宽变化的低透明度软边暗带
  let arrowShadowTex = null;
  function arrowShadowTexture() {
    if (arrowShadowTex) return arrowShadowTex;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 8;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 4, 0, 32, 4, 32);
    grad.addColorStop(0, 'rgba(0,0,0,.95)');
    grad.addColorStop(0.55, 'rgba(0,0,0,.5)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    arrowShadowTex = tex;
    return tex;
  }

  function buildArrowShadow(curve) {
    const n = Math.max(20, Math.ceil(curve.getLength() / 0.3));
    const across = [0, 0.5, 1];
    const stride = across.length;
    const pos = [];
    const uv = [];
    const idx = [];
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curve.getPoint(t);
      tan.copy(curve.getTangent(t)).setY(0);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      side.set(-tan.z, 0, tan.x);
      const w = ARROW_HALF * AW(t) * 2.7;
      for (let j = 0; j < stride; j++) {
        const s = across[j] * 2 - 1;
        const x = p.x + side.x * s * w;
        const z = p.z + side.z * s * w;
        pos.push(x, terrainY(lonAt(x), latAt(z)) + 0.06, z);
        uv.push(across[j], 0.5);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < stride - 1; j++) {
        const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.userData = { segs: n, idxPerSeg: (stride - 1) * 6 };
    return g;
  }

  // 外发光：参照视频里金色路线的那层柔光，改成红色系，垫在箭头下方
  let arrowGlowTex = null;
  function arrowGlowTexture() {
    if (arrowGlowTex) return arrowGlowTex;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.2, 'rgba(255,255,255,.26)');
    g.addColorStop(0.5, 'rgba(255,255,255,.92)');
    g.addColorStop(0.8, 'rgba(255,255,255,.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    arrowGlowTex = tex;
    return tex;
  }

  function buildArrowGlow(curve) {
    const n = Math.max(24, Math.ceil(curve.getLength() / 0.32));
    const across = [0, 0.25, 0.5, 0.75, 1];
    const stride = across.length;
    const pos = [];
    const uv = [];
    const idx = [];
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curve.getPoint(t);
      tan.copy(curve.getTangent(t)).setY(0);
      if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1);
      tan.normalize();
      side.set(-tan.z, 0, tan.x);
      const w = ARROW_HALF * AW(t) * 2.9;
      for (let j = 0; j < stride; j++) {
        const s = across[j] * 2 - 1;
        pos.push(p.x + side.x * s * w, arrowBaseY - 0.05, p.z + side.z * s * w);
        uv.push(0.5, across[j]);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < stride - 1; j++) {
        const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.userData = { segs: n, idxPerSeg: (stride - 1) * 6 };
    return g;
  }

  // 行进前端的高光点：模拟视频里路线头的亮核
  let arrowTipTex = null;
  function arrowTipTexture() {
    if (arrowTipTex) return arrowTipTex;
    const SZ = 64;
    const c = document.createElement('canvas');
    c.width = c.height = SZ;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(SZ / 2, SZ / 2, 0, SZ / 2, SZ / 2, SZ / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,214,180,.72)');
    g.addColorStop(0.55, 'rgba(255,120,72,.24)');
    g.addColorStop(1, 'rgba(255,90,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SZ, SZ);
    arrowTipTex = new THREE.CanvasTexture(c);
    return arrowTipTex;
  }

  const headGeo = buildArrowHeadGeo();

  function buildArrows() {
    arrowGroup = new THREE.Group();
    arrowBaseY = computeArrowBaseY();
    // 描边窄带与贴地阴影全渡共用
    const rimMat = new THREE.MeshBasicMaterial({
      color: 0x5e1710, transparent: true, opacity: 0.5,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide
    });
    const shadowMat = new THREE.MeshBasicMaterial({
      map: arrowShadowTexture(), color: 0x0a0f0b, transparent: true,
      opacity: 0.18, depthWrite: false, side: THREE.DoubleSide
    });
    const mats = [];

    crossings.forEach((cross) => {
      // 每渡一份材质，箭身与箭头共用，保证透明度完全一致
      const mat = new THREE.MeshPhysicalMaterial({
        color: cross.color,
        transparent: true,
        opacity: 0.72,
        roughness: 0.55,
        metalness: 0,
        transmission: 0.2,
        thickness: 0.55,
        ior: 1.4,
        clearcoat: 0.22,
        clearcoatRoughness: 0.45,
        specularIntensity: 0.5,
        emissive: 0x240706,
        emissiveIntensity: 0.2,
        depthWrite: false,
        depthTest: false,   // 统一基准面之上常显，避免被山脊半掩或在旋转变焦时闪烁
        side: THREE.DoubleSide,
        flatShading: false
      });
      tuneArrowMaterial(mat);
      mats.push(mat);

      // 外发光材质：视频里金线的柔光做法，按红色主色降低色相亮度
      const glowColor = new THREE.Color(cross.color).lerp(new THREE.Color(0xff7a52), 0.3);
      const glowMat = new THREE.MeshBasicMaterial({
        map: arrowGlowTexture(), color: glowColor, transparent: true,
        opacity: 0.22, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false
      });

      // 路线前端亮核
      const tip = new THREE.Sprite(new THREE.SpriteMaterial({
        map: arrowTipTexture(), color: 0xffbe98, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false
      }));
      tip.scale.set(3.4, 3.4, 1);
      tip.visible = false;
      tip.renderOrder = 25;
      arrowGroup.add(tip);
      cross._tip = tip;

      cross.stages.forEach((stage) => {
        const s = sampleArrow(stage);
        const shaftGeo = buildArrowShaft(s.pts, s.ts);
        const rimGeo = buildArrowRim(s.pts, s.ts);
        const shadowGeo = buildArrowShadow(s.curve);
        const glowGeo = buildArrowGlow(s.curve);

        const baseOrder = 20 + (cross.no - 1) * 2;

        // 外发光：垫在箭身之下，形成一圈暖红光晕
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.visible = false;
        glow.renderOrder = baseOrder - 0.5;
        arrowGroup.add(glow);

        // 贴地阴影：在地形之上、箭头之下
        const shadow = new THREE.Mesh(shadowGeo, shadowMat);
        shadow.visible = false;
        shadow.renderOrder = 9;
        arrowGroup.add(shadow);

        // 描边窄带：压在箭身之上、箭镞之下，避免透过半透明箭身显出深色条带
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.visible = false;
        rim.renderOrder = baseOrder + 0.5;
        arrowGroup.add(rim);

        const shaft = new THREE.Mesh(shaftGeo, mat);
        shaft.visible = false;
        shaft.renderOrder = baseOrder;
        arrowGroup.add(shaft);

        const head = new THREE.Mesh(headGeo, mat);
        head.visible = false;
        head.renderOrder = baseOrder + 1;
        arrowGroup.add(head);

        stage._pts = s.pts;
        stage._segs = s.pts.length - 1;
        stage._len = s.length;
        stage._cap = shaftGeo.userData.cap;
        stage._idxPerSeg = shaftGeo.userData.idxPerSeg;
        stage._shaft = shaft;
        stage._rim = rim;
        stage._head = head;
        stage._glow = glow;
        stage._shadow = shadow;
        stage._shadowPerSeg = shadowGeo.userData.idxPerSeg;
        stage._rimPerSeg = rimGeo.userData.idxPerSeg;
        stage._glowSegs = glowGeo.userData.segs;
        stage._glowPerSeg = glowGeo.userData.idxPerSeg;
        const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
        stage._tris = {
          shaft: triCount(shaftGeo),
          rim: triCount(rimGeo),
          shadow: triCount(shadowGeo),
          glow: triCount(glowGeo),
          head: triCount(headGeo)
        };
      });
    });
    scene.add(arrowGroup);
    if (window.__CS_DEBUG) { window.__csArrow = { mats, rimMat, shadowMat }; window.__csArrowGroup = arrowGroup; }
  }

  /* ---------------- 高亮环 ---------------- */
  function buildHighlight() {
    highlightRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.035, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xd1533f, transparent: true, opacity: 0.9, depthWrite: false })
    );
    highlightRing.rotation.x = Math.PI / 2;
    highlightRing.visible = false;
    highlightRing.userData.t = 0;
    scene.add(highlightRing);
  }

  let highlightUntil = 0;
  function highlightAt(lon, lat, red) {
    if (!highlightRing) return;
    highlightRing.position.copy(worldPos(lon, lat, 0.32));
    highlightRing.material.color.setHex(red ? 0xd1533f : 0xc9a961);
    highlightRing.visible = true;
    highlightUntil = performance.now() + 4200;
  }

  /* ---------------- 标注 ---------------- */
  function makeLabel(cls, html) {
    const el = document.createElement('div');
    el.className = 'lbl ' + cls;
    el.innerHTML = html;
    labelsBox.appendChild(el);
    return el;
  }

  function buildLabels() {
    const ferryNames = new Set(STORY.ferries.map((f) => f.name));
    STORY.places.forEach((pl) => {
      if (ferryNames.has(pl.name)) return;
      const el = makeLabel(pl.kind === 'city' ? 'city' : pl.kind === 'river' ? 'river' : 'town',
        '<i class="dot"></i><span class="txt">' + pl.name + '</span>');
      labelItems.push({ el, lon: pl.lon, lat: pl.lat, dx: pl.dx, dy: pl.dy, kind: 'place' });
    });

    STORY.ferries.forEach((f) => {
      const el = makeLabel('ferry',
        '<i class="ring"></i><span class="txt">' + f.name + '</span>');
      el.dataset.ferry = f.id;
      el.dataset.crossings = f.crossings.join('|');
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showFerryCard(f.id);
      });
      labelItems.push({ el, lon: f.lon, lat: f.lat, dx: f.dx, dy: f.dy, kind: 'ferry', id: f.id });
    });

    STORY.enemies.forEach((en) => {
      const el = makeLabel('enemy', '<i class="bar"></i><span class="txt">' + en.name + '<em>' + en.sub + '</em></span>');
      labelItems.push({ el, lon: en.lon, lat: en.lat, dx: 16, dy: -8, kind: 'enemy' });
    });

    // 四渡木牌：参照视频里的红底白字竖牌，作为四渡的空间索引
    const PLAQUES = [
      { no: 1, name: '一渡赤水', lon: 105.916, lat: 28.352, dx: -46, dy: -34 },
      { no: 2, name: '二渡赤水', lon: 106.076, lat: 28.208, dx: 42, dy: -64 },
      { no: 3, name: '三渡赤水', lon: 106.428, lat: 27.892, dx: 56, dy: -40 },
      { no: 4, name: '四渡赤水', lon: 106.160, lat: 28.078, dx: 78, dy: 28 }
    ];
    PLAQUES.forEach((pl) => {
      const el = makeLabel('plaque', '<span class="txt">' + pl.name + '</span>');
      el.dataset.no = pl.no;
      plaqueEls.push(el);
      labelItems.push({
        el, lon: pl.lon, lat: pl.lat, dx: pl.dx, dy: pl.dy, kind: 'plaque', no: pl.no,
        y: (arrowBaseY || 0) + 1.1
      });
    });
  }

  function setActiveFerry(id) {
    $$('.lbl.ferry').forEach((el, i) => {
      el.classList.toggle('active', STORY.ferries[i] && STORY.ferries[i].id === id);
    });
    ferryMeshes.forEach((m) => {
      m.material.color.setHex(m.userData.ferry === id ? 0xefb7a0 : 0xc9a961);
      const s = m.userData.ferry === id ? 1.35 : 1;
      m.scale.setScalar(s);
    });
    $$('.lbl.enemy').forEach((el) => el.classList.toggle('show', DAY0STATE.enemies));
  }

  /* ---------------- 视角与交互 ---------------- */
  const VIEW = {
    oblique: { theta: -0.22, phi: 0.86, radius: 104, tz: 4.5 },
    top: { theta: 0, phi: 0.02, radius: 128, tz: 7 }
  };

  function setMode(mode) {
    DAY0STATE.mode = mode;
    $$('.stage-tools .tool[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    if (mode === 'oblique' || mode === 'top') {
      const v = VIEW[mode];
      goalTheta = v.theta;
      goalPhi = v.phi;
      goalRadius = v.radius;
      goalTarget.set(0, 0.6, v.tz);
    } else if (mode === 'follow') {
      goalRadius = 30;
      goalPhi = 0.8;
    }
    if (mode !== 'free') canvas.style.cursor = 'grab';
  }

  $$('.stage-tools .tool[data-view]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.view));
  });

  $('#enemyBtn').addEventListener('click', () => {
    DAY0STATE.enemies = !DAY0STATE.enemies;
    $('#enemyBtn').classList.toggle('on', DAY0STATE.enemies);
    $('#enemyBtn').setAttribute('aria-pressed', String(DAY0STATE.enemies));
    if (enemyGroup) enemyGroup.visible = DAY0STATE.enemies;
    $$('.lbl.enemy').forEach((el) => el.classList.toggle('show', DAY0STATE.enemies));
  });

  let pointerDown = false;
  let pointerMoved = false;
  let lastX = 0, lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    pointerDown = true;
    pointerMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointerMoved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    if (pointerMoved && DAY0STATE.mode !== 'free') setMode('free');
    goalTheta -= dx * 0.005;
    goalPhi = clamp(goalPhi - dy * 0.004, 0.05, 1.4);
    camTheta = goalTheta;
    camPhi = goalPhi;
  });

  canvas.addEventListener('pointerup', (e) => {
    pointerDown = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!pointerMoved) {
      const r = canvas.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(ferryMeshes, false);
      if (hits.length) showFerryCard(hits[0].object.userData.ferry);
    }
  });

  canvas.addEventListener('wheel', (e) => {
    const next = goalRadius + e.deltaY * 0.04;
    // 缩放到尽头后把滚轮交还页面，避免沙盘把滚动完全吃掉
    if ((next > 170 && e.deltaY > 0) || (next < 26 && e.deltaY < 0)) return;
    e.preventDefault();
    goalRadius = clamp(next, 26, 170);
  }, { passive: false });

  function bindControls() {
    window.addEventListener('resize', resize);
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        stageVisible = en.isIntersecting;
        if (!en.isIntersecting && DAY0STATE.playing) pausePlayback();
      });
    }, { threshold: 0.01 });
    obs.observe(stage);
  }

  function resize() {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ---------------- 三维更新 ---------------- */
  function updateThree(day) {
    currentHeads = [];
    crossings.forEach((cross) => {
      cross.stages.forEach((stage) => {
        const p = clamp((day - stage.d0 + 0.45) / (stage.d1 - stage.d0), 0, 1);
        const active = day >= stage.d0;
        stage._p = p;
        stage._shaft.visible = active && p > 0.01;
        stage._rim.visible = stage._shaft.visible;
        stage._glow.visible = stage._shaft.visible;
        stage._shadow.visible = active && p > 0.02;
        if (!stage._shaft.visible) {
          stage._head.visible = false;
          return;
        }
        const segs = stage._segs;
        const grown = Math.max(1, Math.floor(segs * p));
        const shaftLen = stage._cap + grown * stage._idxPerSeg;
        stage._shaft.geometry.setDrawRange(0, shaftLen);
        // 发光带比箭身略早收尾，避免在箭镞下透出圆头光斑
        stage._glow.geometry.setDrawRange(0,
          Math.max(1, Math.floor(stage._glowSegs * p)) * stage._glowPerSeg);
        // 描边窄带不进入箭镞覆盖区，避免在镞体下透出深色折线
        const trim = Math.ceil(((HEAD_OVERLAP + 0.18) / (stage._len || 1)) * segs);
        stage._rim.geometry.setDrawRange(0, Math.max(0, grown - trim) * stage._rimPerSeg);
        const shadowSegs = stage._shadow.geometry.userData.segs;
        stage._shadow.geometry.setDrawRange(0,
          Math.max(1, Math.floor(shadowSegs * p)) * stage._shadowPerSeg);
        const idx = clamp(Math.floor(segs * p), 0, segs);
        const pt = stage._pts[idx];
        const prev = stage._pts[Math.max(idx - 1, 0)];
        const tan = new THREE.Vector3(pt.x - prev.x, 0, pt.z - prev.z);
        if (tan.lengthSq() < 1e-6) tan.set(0, 0, 1);
        tan.normalize();
        // 箭镞沿末端切线朝向，回退一段与箭身重叠，生长过程中不出现断裂
        const hx = pt.x - tan.x * HEAD_OVERLAP;
        const hz = pt.z - tan.z * HEAD_OVERLAP;
        stage._head.position.set(hx, pt.y + 0.01, hz);
        stage._head.rotation.y = Math.atan2(tan.x, tan.z);
        stage._lead = { pos: pt, tan: tan, end: p >= 0.999, d1: stage.d1 };
      });
      // 一条渡只保留最前端的一个箭镞，已走完的分段不再显示遗留箭头
      let lead = null;
      cross.stages.forEach((s) => {
        if (s._p > 0.02 && s._shaft.visible) lead = s;
        s._head.visible = false;
      });
      if (lead) {
        lead._head.visible = true;
        currentHeads.push({ pos: lead._lead.pos, tan: lead._lead.tan, cross, end: lead._lead.end, d1: lead._lead.d1 });
        if (cross._tip) {
          cross._tip.visible = true;
          cross._tip.position.set(lead._lead.pos.x, lead._lead.pos.y + 0.32, lead._lead.pos.z);
          const pulse = 0.86 + Math.sin(performance.now() * 0.006) * 0.14;
          cross._tip.material.opacity = 0.72 * pulse;
        }
      } else if (cross._tip) {
        cross._tip.visible = false;
      }
    });

    // 渡口高亮：仅在实际渡河日窗口内
    const activeFerryIds = [];
    crossings.forEach((c) => {
      const hold = c.no === 2 ? 3 : 2.2;
      if (day >= c.day0 - 0.2 && day <= c.day0 + hold) {
        if (c.no === 1) activeFerryIds.push('tucheng', 'yuanhou');
        if (c.no === 2) activeFerryIds.push('taiping', 'erlang');
        if (c.no === 3) activeFerryIds.push('maotai');
        if (c.no === 4) activeFerryIds.push('taiping', 'erlang', 'jiuxikou');
      }
    });
    if (day > 69) activeFerryIds.push('wujiang');
    $$('.lbl.ferry').forEach((el, i) => {
      const f = STORY.ferries[i];
      if (!f) return;
      el.classList.toggle('active', activeFerryIds.indexOf(f.id) >= 0 || f.id === (DAY0STATE.ferryCard || ''));
    });
    ferryMeshes.forEach((m) => {
      const active = activeFerryIds.indexOf(m.userData.ferry) >= 0;
      if (!active && m.userData.ferry === (DAY0STATE.ferryCard || '')) return;
      m.material.color.setHex(active ? 0xef7a5c : 0xc9a961);
      m.scale.setScalar(active ? 1.25 + Math.sin(performance.now() * 0.004) * 0.1 : 1);
      m.material.opacity = active ? 0.95 : 0.7;
    });

    // 四渡木牌：当前渡次点亮，其余淡出
    plaqueEls.forEach((el) => {
      const c = crossings.find((x) => x.no === Number(el.dataset.no));
      const on = !!c && day >= c.day0 - 1 && day <= c.day1 + 4;
      el.classList.toggle('active', on);
    });
  }

  /* ---------------- 渲染循环 ---------------- */
  let lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!threeReady || !stageVisible) return;

    const dt = Math.min(0.05, (t - lastFrame) / 1000 || 0.016);
    lastFrame = t;

    if (DAY0STATE.mode === 'follow' && currentHeads.length) {
      camera.up.set(0, 1, 0);
      let h = currentHeads[0];
      for (const item of currentHeads) if (item.d1 >= h.d1) h = item;
      const want = new THREE.Vector3(h.pos.x, h.pos.y + 0.4, h.pos.z);
      goalTarget.lerp(want, 0.09);
      const back = 16, up = 11;
      const wx = want.x - h.tan.x * back;
      const wz = want.z - h.tan.z * back;
      const wy = want.y + up;
      camera.position.lerp(new THREE.Vector3(wx, wy, wz), 0.07);
      camera.lookAt(goalTarget);
    } else {
      camTheta = lerp(camTheta, goalTheta, 0.09);
      camPhi = lerp(camPhi, goalPhi, 0.09);
      camRadius = lerp(camRadius, goalRadius, 0.09);
      camTarget.lerp(goalTarget, 0.09);
      camera.up.set(0, DAY0STATE.mode === 'top' ? 0 : 1, DAY0STATE.mode === 'top' ? -1 : 0);
      const sp = new THREE.Vector3(
        camRadius * Math.sin(camPhi) * Math.sin(camTheta),
        camRadius * Math.cos(camPhi),
        camRadius * Math.sin(camPhi) * Math.cos(camTheta)
      );
      camera.position.copy(camTarget).add(sp);
      camera.lookAt(camTarget);
    }

    // 高亮环呼吸
    if (highlightRing && highlightRing.visible) {
      const k = 1 + Math.sin(t * 0.004) * 0.12;
      highlightRing.scale.setScalar(k);
      highlightRing.material.opacity = 0.55 + Math.sin(t * 0.003) * 0.3;
      if (t > highlightUntil) highlightRing.visible = false;
    }

    // 敌军层轻微呼吸
    if (enemyGroup && enemyGroup.visible) {
      enemyGroup.children.forEach((m, i) => {
        if (m.isLine) return;
        m.material.opacity = 0.45 + Math.sin(t * 0.002 + i) * 0.12;
      });
    }

    // 云层极缓漂移
    if (cloudGroup) {
      cloudGroup.children.forEach((sp, i) => {
        sp.position.x = sp.userData.x0 + Math.sin(t * 0.00007 + i * 0.8) * sp.userData.range;
      });
    }

    projectLabels();
    renderer.render(scene, camera);
    if (window.__CS_DEBUG) {
      window.__csStats = {
        tris: renderer.info.render.triangles,
        calls: renderer.info.render.calls,
        stages: crossings.map((c) => ({
          no: c.no,
          segs: c.stages.map((s) => s._segs || 0),
          tris: c.stages.reduce((a, s) => {
            const t = s._tris || {};
            return a + (t.shaft || 0) + (t.rim || 0) + (t.head || 0) + (t.shadow || 0);
          }, 0)
        }))
      };
      window.__csPlay = playState
        ? {
            i: playState.i,
            day: playState.beat.day,
            startDay: playState.startDay,
            endDay: playState.endDay,
            phase: playState.phase,
            moveMs: playState.moveMs,
            elapsed: performance.now() - playState.moveStart,
            paused: playState.paused,
            finished: playState.finished
          }
        : null;
    }
    void dt;
    void clock;
  }

  function projectLabels() {
    if (!labelsBox) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const v = new THREE.Vector3();
    labelItems.forEach((it) => {
      if (it.y != null) v.set(toX(it.lon), it.y, toZ(it.lat));
      else v.copy(worldPos(it.lon, it.lat, 0.35));
      v.project(camera);
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      if (v.z > 1 || x < -60 || x > w + 60 || y < 46 || y > h - 150) {
        it.el.style.display = 'none';
        return;
      }
      it.el.style.display = '';
      it.el.style.left = x + it.dx + 'px';
      it.el.style.top = y + it.dy + 'px';
    });
  }

  /* ======================================================================
     二维降级
     ====================================================================== */
  let fallbackReady = false;
  let fbCanvas, fbCtx, fbHill = null, fbSize = { w: 0, h: 0 };

  function initFallback() {
    $('#fallback').hidden = false;
    $('#fallback').classList.add('show');
    canvas.style.display = 'none';
    labelsBox.style.display = 'none';
    fbCanvas = $('#fallbackCanvas');
    fbCtx = fbCanvas.getContext('2d');
    fallbackReady = true;
    $$('.stage-tools .tool[data-view]').forEach((b) => { b.disabled = true; });
    window.addEventListener('resize', () => { fbSize.w = 0; drawFallback(); });
    drawFallback();
  }

  function buildHillshade() {
    const SZ = 520;
    const img = fbCtx.createImageData(SZ, SZ);
    const data = img.data;
    const sunX = -0.6, sunY = -0.6, sunZ = 0.72;
    for (let py = 0; py < SZ; py++) {
      for (let px = 0; px < SZ; px++) {
        const lon = W + (px / (SZ - 1)) * (E - W);
        const lat = N - (py / (SZ - 1)) * (N - S);
        const h = demAt(lon, lat);
        const hx = demAt(lon + 0.003, lat) - h;
        const hy = demAt(lon, lat - 0.003) - h;
        const nz = Math.sqrt(hx * hx + hy * hy + 9);
        const shade = clamp(0.42 + ((-hx * sunX - hy * sunY) / nz) * 0.85, 0.2, 1.25);
        const e = clamp((h - 280) / 1700, 0, 1);
        let r = Math.round((44 + e * 46) * shade);
        let g = Math.round((66 + e * 44) * shade);
        let b = Math.round((54 + e * 40) * shade);
        const i = (py * SZ + px) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    const c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function fbXY(lon, lat) {
    return [
      ((lon - W) / (E - W)) * fbSize.w,
      ((N - lat) / (N - S)) * fbSize.h
    ];
  }

  function drawFallback() {
    if (!fallbackReady) return;
    const wrap = fbCanvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (fbSize.w !== w || fbSize.h !== h) {
      fbCanvas.width = w * dpr;
      fbCanvas.height = h * dpr;
      fbCanvas.style.width = w + 'px';
      fbCanvas.style.height = h + 'px';
      fbSize = { w, h };
    }
    fbCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fbCtx.clearRect(0, 0, w, h);
    if (!fbHill) fbHill = buildHillshade();
    fbCtx.drawImage(fbHill, 0, 0, w, h);

    // 河流
    fbCtx.strokeStyle = 'rgba(95,154,140,.85)';
    fbCtx.lineWidth = 2.2;
    fbCtx.beginPath();
    RIVER.points.forEach(([lon, lat], i) => {
      const [x, y] = fbXY(lon, lat);
      if (i) fbCtx.lineTo(x, y); else fbCtx.moveTo(x, y);
    });
    fbCtx.stroke();

    // 行军箭头（降级模式保持 0.85 不透明度的实心红，不参与磨砂效果）
    const day = DAY0STATE.day;
    fbCtx.globalAlpha = 0.85;
    crossings.forEach((cross) => {
      const hex = '#' + cross.color.toString(16).padStart(6, '0');
      cross.stages.forEach((stage) => {
        const p = clamp((day - stage.d0) / (stage.d1 - stage.d0), 0, 1);
        if (p <= 0) return;
        const pts = [];
        const seg = stage.pts;
        const total = seg.length - 1;
        for (let i = 0; i <= total; i++) {
          if (i / total <= p) pts.push(fbXY(seg[i][0], seg[i][1]));
        }
        if (pts.length < 2) return;
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        fbCtx.strokeStyle = hex;
        fbCtx.lineWidth = 3.4;
        fbCtx.lineCap = 'round';
        fbCtx.beginPath();
        pts.forEach(([x, y], i) => (i ? fbCtx.lineTo(x, y) : fbCtx.moveTo(x, y)));
        fbCtx.stroke();
        const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
        fbCtx.save();
        fbCtx.translate(last[0], last[1]);
        fbCtx.rotate(ang);
        fbCtx.fillStyle = hex;
        fbCtx.beginPath();
        fbCtx.moveTo(0, 0);
        fbCtx.lineTo(-9, 4.2);
        fbCtx.lineTo(-9, -4.2);
        fbCtx.closePath();
        fbCtx.fill();
        fbCtx.restore();
      });
    });

    fbCtx.globalAlpha = 1;

    // 地名
    const ferriesOn = [];
    crossings.forEach((c) => {
      if (day >= c.day0 - 0.5 && day <= c.day1 + 0.5) {
        if (c.no === 1) ferriesOn.push('tucheng', 'yuanhou');
        if (c.no === 2) ferriesOn.push('taiping', 'erlang');
        if (c.no === 3) ferriesOn.push('maotai');
        if (c.no === 4) ferriesOn.push('taiping', 'erlang', 'jiuxikou');
      }
    });
    if (day > 69) ferriesOn.push('wujiang');

    STORY.ferries.forEach((f) => {
      const [x, y] = fbXY(f.lon, f.lat);
      const on = ferriesOn.indexOf(f.id) >= 0;
      fbCtx.strokeStyle = on ? '#e87a58' : 'rgba(201,169,97,.9)';
      fbCtx.lineWidth = on ? 2 : 1.2;
      fbCtx.beginPath();
      fbCtx.arc(x, y, on ? 6 : 4.4, 0, Math.PI * 2);
      fbCtx.stroke();
      fbCtx.fillStyle = 'rgba(230,220,196,.95)';
      fbCtx.font = '11px "Songti SC", serif';
      fbCtx.textAlign = 'center';
      fbCtx.fillText(f.name, x, y - 9);
    });

    STORY.places.forEach((pl) => {
      const [x, y] = fbXY(pl.lon, pl.lat);
      fbCtx.fillStyle = 'rgba(233,223,201,.9)';
      fbCtx.beginPath();
      fbCtx.arc(x, y, 2.2, 0, Math.PI * 2);
      fbCtx.fill();
      fbCtx.fillStyle = 'rgba(201,189,164,.85)';
      fbCtx.font = '11px "Songti SC", serif';
      fbCtx.textAlign = 'center';
      fbCtx.fillText(pl.name, x, y + 15);
    });

    if (DAY0STATE.enemies) {
      STORY.enemies.forEach((en) => {
        const [x, y] = fbXY(en.lon, en.lat);
        fbCtx.strokeStyle = 'rgba(108,139,152,.85)';
        fbCtx.lineWidth = 1.4;
        fbCtx.beginPath();
        fbCtx.moveTo(x, y);
        const a = rad(en.dir);
        fbCtx.lineTo(x + Math.sin(a) * 22, y - Math.cos(a) * 22);
        fbCtx.stroke();
        fbCtx.fillStyle = 'rgba(169,194,205,.95)';
        fbCtx.font = '10px "PingFang SC", sans-serif';
        fbCtx.textAlign = 'left';
        fbCtx.fillText(en.name, x + 8, y - 6);
      });
    }

    // 日期
    fbCtx.fillStyle = 'rgba(233,223,201,.9)';
    fbCtx.font = '600 15px "PingFang SC", sans-serif';
    fbCtx.textAlign = 'right';
    fbCtx.fillText(isoOf(Math.round(day)).label, w - 18, 28);
  }

  /* ======================================================================
     主状态更新
     ====================================================================== */
  function setDay(day, fromUI) {
    DAY0STATE.day = clamp(day, 0, DAYS);
    updateUI(DAY0STATE.day);
    if (threeReady) updateThree(DAY0STATE.day);
    if (fallbackReady) drawFallback();
    void fromUI;
  }

  /* ---------------- 启动 ---------------- */
  const ok = initThree();
  if (ok) {
    updateThree(0);
    requestAnimationFrame(frame);
    setMode('oblique');
  } else {
    initFallback();
  }
  updateUI(0);
  setDay(0);
})();
