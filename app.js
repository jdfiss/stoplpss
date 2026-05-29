const PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;
let positions = [];
let unsub = null;
let detailPos = null;
let detailCandles = null;
let detailMeta = null;
let detailK = 2.0;

// ── Auth ──
function getLastUser() { try { return JSON.parse(localStorage.getItem('lastUser') || 'null'); } catch { return null; } }

function showQuickLogin() {
  const last = getLastUser();
  if (!last?.photo) return;
  document.getElementById('quick-avatar').src = last.photo;
  document.getElementById('quick-name').textContent = last.name || '使用者';
  document.getElementById('quick-email').textContent = last.email || '';
  document.getElementById('quick-login-section').classList.remove('hidden');
  document.getElementById('google-login-btn').style.display = 'none';
}
showQuickLogin();

auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    localStorage.setItem('lastUser', JSON.stringify({
      name: user.displayName, photo: user.photoURL, email: user.email
    }));
    const av = document.getElementById('user-avatar');
    if (user.photoURL) { av.src = user.photoURL; av.style.display = 'block'; }
    showScreen('dashboard');
    subscribePositions();
  } else {
    currentUser = null;
    if (unsub) unsub();
    showScreen('login');
    showQuickLogin();
  }
});

function doGoogleLogin(hintEmail) {
  const provider = new firebase.auth.GoogleAuthProvider();
  if (hintEmail) provider.setCustomParameters({ login_hint: hintEmail });
  auth.signInWithPopup(provider).catch(e => alert('登入失敗：' + e.message));
}

document.getElementById('google-login-btn').addEventListener('click', () => doGoogleLogin());
document.getElementById('quick-login-btn').addEventListener('click', () => doGoogleLogin(getLastUser()?.email));
document.getElementById('switch-account-btn').addEventListener('click', () => {
  localStorage.removeItem('lastUser');
  document.getElementById('quick-login-section').classList.add('hidden');
  document.getElementById('google-login-btn').style.display = 'flex';
});

document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

// ── Screens ──
function showScreen(name) {
  ['login', 'dashboard', 'detail'].forEach(s => {
    document.getElementById(`${s}-screen`).classList.toggle('hidden', s !== name);
  });
}

// ── Firestore ──
function subscribePositions() {
  if (unsub) unsub();
  const ref = db.collection('users').doc(currentUser.uid).collection('positions');
  unsub = ref.orderBy('createdAt', 'desc').onSnapshot(snap => {
    positions = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    renderDashboard();
  }, err => console.error(err));
}

async function savePosition(data) {
  await db.collection('users').doc(currentUser.uid).collection('positions')
    .add({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function removePosition(id) {
  await db.collection('users').doc(currentUser.uid).collection('positions').doc(id).delete();
}

// ── Stock Chinese Name (TWSE / TPEx OpenAPI, cached) ──
let twListCache = null;
let twListPromise = null;

async function tryFetchJson(url, timeout = 8000) {
  try {
    const r = await fetchWithTimeout(url, timeout);
    if (r.ok) return await r.json();
  } catch {}
  for (const makeProxy of PROXIES) {
    try {
      const r = await fetchWithTimeout(makeProxy(url), timeout);
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

async function loadTwStockList() {
  if (twListCache) return twListCache;
  if (twListPromise) return twListPromise;

  twListPromise = (async () => {
    try {
      const stored = localStorage.getItem('twStockList');
      const ts = parseInt(localStorage.getItem('twStockListTs') || '0');
      if (stored && Date.now() - ts < 7 * 86400 * 1000) {
        twListCache = JSON.parse(stored);
        return twListCache;
      }
    } catch {}

    const list = {};
    const urls = [
      'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
      'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O'
    ];
    for (const url of urls) {
      const data = await tryFetchJson(url, 10000);
      if (Array.isArray(data)) {
        data.forEach(c => {
          const code = c.公司代號 || c.SecuritiesCompanyCode || c.Code || '';
          const name = c.公司簡稱 || c.CompanyAbbreviation || c.AbbreviationName || '';
          if (code && name) list[code] = name;
        });
      }
    }

    twListCache = list;
    if (Object.keys(list).length > 0) {
      try {
        localStorage.setItem('twStockList', JSON.stringify(list));
        localStorage.setItem('twStockListTs', Date.now().toString());
      } catch {}
    }
    return list;
  })();

  return twListPromise;
}

async function fetchStockName(ticker) {
  const list = await loadTwStockList();
  if (list[ticker]) return list[ticker];

  // Fallback：用 STOCK_DAY 單檔 title 解析
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  const urls = [
    `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ymd}&stockNo=${ticker}`
  ];
  for (const url of urls) {
    const data = await tryFetchJson(url, 5000);
    const title = data?.title || data?.reportTitle || '';
    if (title) {
      const parts = title.split(/\s+/);
      const idx = parts.indexOf(ticker);
      if (idx !== -1 && idx + 1 < parts.length && /[一-鿿]/.test(parts[idx+1])) {
        // 順便補進 cache
        list[ticker] = parts[idx+1];
        try { localStorage.setItem('twStockList', JSON.stringify(list)); } catch {}
        return parts[idx+1];
      }
    }
  }
  return '';
}

// ── Yahoo Finance ──
async function fetchCandles(ticker) {
  const namePromise = fetchStockName(ticker);
  for (const suffix of ['.TW', '.TWO']) {
    const url = `${YAHOO}${ticker}${suffix}?interval=1d&range=6mo`;
    for (const makeProxy of PROXIES) {
      try {
        const res = await fetchWithTimeout(makeProxy(url), 8000);
        if (!res.ok) continue;
        const json = await res.json();
        const candles = parseYahooData(json);
        const meta = parseYahooMeta(json) || { symbol: '', name: '' };
        if (candles && candles.length >= 5) {
          const cn = await namePromise.catch(() => '');
          if (cn) meta.name = cn;
          return { candles, meta };
        }
      } catch { continue; }
    }
  }
  return null;
}

function fetchWithTimeout(url, ms = 8000) {
  return Promise.race([
    fetch(url),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

async function fetchNews(ticker, stockName) {
  const fiveDaysAgoSec = Math.floor(Date.now() / 1000) - 5 * 86400;
  const queries = [
    stockName ? `${stockName} 股價` : '',
    stockName ? `${ticker} ${stockName}` : '',
    `${ticker} 台股`
  ].filter(Boolean);

  // 策略 1：Google News RSS 透過 CORS proxy → 直接解 XML
  for (const q of queries) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    for (const makeProxy of PROXIES) {
      try {
        const res = await fetchWithTimeout(makeProxy(rssUrl), 6000);
        if (!res.ok) continue;
        const text = await res.text();
        if (!text.includes('<item>')) continue;
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        const items = Array.from(doc.querySelectorAll('item'));
        if (!items.length) continue;
        const news = items.map(it => {
          const t = it.querySelector('title')?.textContent || '';
          const cleanTitle = t.replace(/\s+-\s+[^-]+$/, '');
          const src = (t.match(/-\s+([^-]+)$/) || [])[1] || '';
          return {
            title: cleanTitle,
            link: it.querySelector('link')?.textContent || '',
            publisher: it.querySelector('source')?.textContent || src.trim(),
            providerPublishTime: new Date(it.querySelector('pubDate')?.textContent).getTime() / 1000
          };
        }).filter(n => n.providerPublishTime >= fiveDaysAgoSec)
          .sort((a, b) => b.providerPublishTime - a.providerPublishTime);
        if (news.length) return news;
      } catch { continue; }
    }
  }

  // 策略 2：rss2json fallback
  for (const q of queries) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=20`;
    try {
      const res = await fetchWithTimeout(apiUrl, 6000);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.status !== 'ok' || !json.items?.length) continue;
      const news = json.items.map(it => {
        const t = it.title || '';
        return {
          title: t.replace(/\s+-\s+[^-]+$/, ''),
          link: it.link,
          publisher: (t.match(/-\s+([^-]+)$/) || [])[1] || '',
          providerPublishTime: new Date(it.pubDate).getTime() / 1000
        };
      }).filter(n => n.providerPublishTime >= fiveDaysAgoSec)
        .sort((a, b) => b.providerPublishTime - a.providerPublishTime);
      if (news.length) return news;
    } catch { continue; }
  }

  // 策略 3：Yahoo Finance 新聞 (覆蓋率較差但穩定)
  for (const suffix of ['.TW', '.TWO']) {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}${suffix}&newsCount=15&quotesCount=0&lang=zh-TW&region=TW`;
    for (const makeProxy of PROXIES) {
      try {
        const res = await fetchWithTimeout(makeProxy(url), 6000);
        if (!res.ok) continue;
        const json = await res.json();
        if (!json.news?.length) continue;
        const news = json.news
          .filter(n => n.providerPublishTime >= fiveDaysAgoSec)
          .sort((a, b) => b.providerPublishTime - a.providerPublishTime);
        if (news.length) return news;
      } catch { continue; }
    }
  }
  return [];
}

function renderKLine(container, detailBox, candles, days = 14) {
  const recent = candles.slice(-days);
  if (recent.length === 0) { container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">無 K 線資料</div>'; return; }
  const W = 100, H = 60;
  const padL = 0, padR = 8, padT = 4, padB = 12;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const allHigh = Math.max(...recent.map(c => c.high));
  const allLow = Math.min(...recent.map(c => c.low));
  const range = allHigh - allLow || 1;
  const slotW = innerW / recent.length;
  const candleW = Math.max(slotW * 0.65, 0.6);

  const y = v => padT + ((allHigh - v) / range) * innerH;
  const x = i => padL + slotW * (i + 0.5);

  let bars = '';
  let hits = '';
  recent.forEach((c, i) => {
    const isUp = c.close >= c.open;
    const color = isUp ? '#ff6b8a' : '#7ee0a8';
    const cx = x(i);
    const yH = y(c.high), yL = y(c.low);
    const yO = y(c.open), yC = y(c.close);
    const top = Math.min(yO, yC), bot = Math.max(yO, yC);
    const h = Math.max(bot - top, 0.4);
    bars += `<line x1="${cx}" y1="${yH}" x2="${cx}" y2="${yL}" stroke="${color}" stroke-width="0.4"/>`;
    bars += `<rect x="${cx - candleW/2}" y="${top}" width="${candleW}" height="${h}" fill="${color}"/>`;
    hits += `<rect class="k-hit" data-idx="${i}" x="${padL + slotW * i}" y="${padT}" width="${slotW}" height="${innerH}" fill="transparent" style="cursor:pointer"/>`;
  });

  const firstDate = recent[0].date.slice(5);
  const lastDate = recent[recent.length - 1].date.slice(5);

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:200px;display:block">
      ${bars}
      <g id="crosshair" style="display:none;pointer-events:none">
        <line id="ch-v" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="rgba(255,255,255,.5)" stroke-width="0.2" stroke-dasharray="0.6,0.4"/>
        <line id="ch-h" x1="${padL}" y1="0" x2="${W - padR}" y2="0" stroke="rgba(255,255,255,.5)" stroke-width="0.2" stroke-dasharray="0.6,0.4"/>
        <rect id="ch-tag-bg" x="0" y="0" width="9" height="3.6" fill="rgba(183,148,244,.95)" rx="0.6"/>
        <text id="ch-tag" x="0" y="0" font-size="2.6" fill="#1a1625" text-anchor="middle" font-weight="700"></text>
      </g>
      ${hits}
      <text x="${padL}" y="${H - 2}" font-size="3" fill="#a39cb8">${firstDate}</text>
      <text x="${W - padR}" y="${H - 2}" font-size="3" fill="#a39cb8" text-anchor="end">${lastDate}</text>
      <text x="${W - padR}" y="${padT + 3}" font-size="3" fill="#a39cb8" text-anchor="end">${allHigh.toFixed(2)}</text>
      <text x="${W - padR}" y="${H - padB}" font-size="3" fill="#a39cb8" text-anchor="end">${allLow.toFixed(2)}</text>
    </svg>`;

  const showCandle = c => {
    const prev = candles[candles.indexOf(c) - 1];
    const chgVal = prev ? c.close - prev.close : 0;
    const chgPct = prev ? (chgVal / prev.close * 100) : 0;
    const chgCls = chgVal >= 0 ? 'up' : 'down';
    const chgStr = prev ? `${chgVal >= 0 ? '+' : ''}${chgVal.toFixed(2)} (${chgVal >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : '—';
    detailBox.innerHTML = `
      <div class="kd-date">${c.date}</div>
      <div class="kd-row">
        <span class="kd-item"><label>開</label><b>${c.open.toFixed(2)}</b></span>
        <span class="kd-item"><label>高</label><b style="color:var(--red)">${c.high.toFixed(2)}</b></span>
        <span class="kd-item"><label>低</label><b style="color:var(--green)">${c.low.toFixed(2)}</b></span>
        <span class="kd-item"><label>收</label><b>${c.close.toFixed(2)}</b></span>
        <span class="kd-item"><label>漲跌</label><b class="${chgCls}">${chgStr}</b></span>
      </div>`;
  };

  const crosshair = container.querySelector('#crosshair');
  const chV = container.querySelector('#ch-v');
  const chH = container.querySelector('#ch-h');
  const chTag = container.querySelector('#ch-tag');
  const chTagBg = container.querySelector('#ch-tag-bg');

  const moveCrosshair = (idx) => {
    const c = recent[idx];
    const cx = x(idx);
    const cy = y(c.close);
    crosshair.style.display = '';
    chV.setAttribute('x1', cx);
    chV.setAttribute('x2', cx);
    chH.setAttribute('y1', cy);
    chH.setAttribute('y2', cy);
    chTag.textContent = c.close.toFixed(2);
    const tagX = W - padR - 0.5;
    const tagY = cy + 1.2;
    chTagBg.setAttribute('x', tagX - 9);
    chTagBg.setAttribute('y', cy - 1.8);
    chTag.setAttribute('x', tagX - 4.5);
    chTag.setAttribute('y', tagY);
  };

  const hideCrosshair = () => { crosshair.style.display = 'none'; };

  const select = (idx) => {
    showCandle(recent[idx]);
    moveCrosshair(idx);
  };

  // 預設顯示最後一根
  select(recent.length - 1);

  container.querySelectorAll('.k-hit').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    el.addEventListener('mouseenter', () => select(idx));
    el.addEventListener('touchstart', e => { e.preventDefault(); select(idx); }, { passive: false });
    el.addEventListener('click', () => select(idx));
  });
}

function renderNewsList(container, news) {
  if (!news || news.length === 0) {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;font-size:13px;line-height:1.6">暫無近 5 日相關新聞 🦗<br><span style="font-size:11px">（資料來源限制，僅供參考）</span></div>';
    return;
  }
  container.innerHTML = news.slice(0, 8).map(n => {
    const ts = n.providerPublishTime ? new Date(n.providerPublishTime * 1000) : null;
    const now = Date.now();
    let dateStr = '';
    if (ts) {
      const diffMin = Math.floor((now - ts.getTime()) / 60000);
      if (diffMin < 60) dateStr = `${diffMin} 分前`;
      else if (diffMin < 1440) dateStr = `${Math.floor(diffMin/60)} 小時前`;
      else dateStr = `${ts.getMonth()+1}/${ts.getDate()}`;
    }
    return `<a href="${n.link}" target="_blank" rel="noopener" class="news-item">
      <div class="news-title">${n.title}</div>
      <div class="news-meta">${n.publisher || '—'} · ${dateStr}</div>
    </a>`;
  }).join('');
}

// ── Dashboard ──
function renderDashboard() {
  const grid = document.getElementById('positions-grid');
  const empty = document.getElementById('empty-state');
  if (positions.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = '';
  positions.forEach(pos => {
    const card = buildCardShell(pos);
    grid.appendChild(card);
    populateCard(pos, card);
  });
}

function buildCardShell(pos) {
  const el = document.createElement('div');
  el.className = 'position-card';
  el.innerHTML = `
    <div class="card-top">
      <div class="ticker-badge">${pos.data.ticker}</div>
      <div class="tf-badge">${pos.data.timeframe === 'short' ? '短線' : '中長線'}</div>
    </div>
    <div class="card-entry">買進 ${Number(pos.data.buyPrice).toFixed(2)} 元 · ${pos.data.buyDate}</div>
    <div class="card-skeleton">載入中...</div>`;
  el.addEventListener('click', () => openDetail(pos));
  return el;
}

async function populateCard(pos, card) {
  const result = await fetchCandles(pos.data.ticker);
  if (!result) {
    card.querySelector('.card-skeleton').textContent = '無法取得資料';
    return;
  }
  const { candles, meta } = result;
  const name = meta?.name || pos.data.stockName || '';
  const k = pos.data.kValue || (pos.data.timeframe === 'short' ? 2.0 : 3.0);
  const sig = calculateAllSignals(pos.data, candles, k);
  const gainClass = sig.gain >= 0 ? 'up' : 'down';
  const gainStr = (sig.gain >= 0 ? '+' : '') + sig.gain.toFixed(2) + '%';
  const stops = sig.stopSignals.filter(s => s.triggered);
  const profits = sig.profitSignals.filter(s => s.triggered);
  if (stops.length) card.classList.add('has-stop');
  else if (profits.length) card.classList.add('has-profit');
  let pills = [
    ...stops.map(s => `<span class="pill pill-red">${s.label}</span>`),
    ...profits.map(s => `<span class="pill pill-green">${s.label}</span>`)
  ];
  if (!pills.length) pills = ['<span class="pill pill-ok">訊號正常</span>'];
  card.innerHTML = `
    <div class="card-top">
      <div class="ticker-wrap">
        <div class="ticker-badge">${pos.data.ticker}</div>
        ${name ? `<div class="stock-name">${name}</div>` : ''}
      </div>
      <div class="tf-badge">${pos.data.timeframe === 'short' ? '短線' : '中長線'}</div>
    </div>
    <div class="price-row">
      <div class="card-price">${sig.currentPrice.toFixed(2)}</div>
      <div class="card-gain ${gainClass}">${gainStr}</div>
    </div>
    <div class="card-entry">買進 ${Number(pos.data.buyPrice).toFixed(2)} · ${pos.data.buyDate}</div>
    <div class="card-pills">${pills.join('')}</div>`;
  card.addEventListener('click', () => openDetail(pos));
}

// ── Add Modal ──
document.getElementById('add-btn').addEventListener('click', () => {
  document.getElementById('input-buy-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('position-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-ticker').focus(), 100);
});

// 自動填入昨日收盤價
let tickerTimer = null;
let lastFetchedTicker = '';
const priceInput = document.getElementById('input-buy-price');
const tickerInput = document.getElementById('input-ticker');
const priceHint = document.getElementById('price-hint');

let pendingStockName = '';
tickerInput.addEventListener('input', () => {
  clearTimeout(tickerTimer);
  const ticker = tickerInput.value.trim().toUpperCase();
  if (ticker.length < 4 || ticker === lastFetchedTicker) return;
  tickerTimer = setTimeout(async () => {
    if (priceInput.value && priceInput.dataset.autofilled !== 'true') return;
    priceInput.classList.add('loading');
    priceHint.textContent = '🔍 抓取最新收盤價中...';
    const result = await fetchCandles(ticker);
    priceInput.classList.remove('loading');
    if (result?.candles?.length > 0) {
      const last = result.candles[result.candles.length - 1];
      const nm = result.meta?.name || '';
      pendingStockName = nm;
      priceInput.value = last.close.toFixed(2);
      priceInput.dataset.autofilled = 'true';
      priceHint.innerHTML = `✅ <b style="color:var(--blue)">${ticker} ${nm}</b> · ${last.date} 收盤 <b style="color:var(--blue)">${last.close.toFixed(2)}</b>，可手動改`;
      lastFetchedTicker = ticker;
    } else {
      pendingStockName = '';
      priceHint.innerHTML = '❌ 找不到此股號，請確認是 4 碼台股代號（例：2330）';
    }
  }, 600);
});

// 使用者手動改價時，取消 autofill 標記
priceInput.addEventListener('input', () => {
  if (priceInput.value !== '' && document.activeElement === priceInput) {
    priceInput.dataset.autofilled = 'false';
  }
});
document.getElementById('cancel-modal-btn').addEventListener('click', closeModal);
document.getElementById('position-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('position-modal')) closeModal();
});
function closeModal() {
  document.getElementById('position-modal').classList.add('hidden');
  document.getElementById('position-form').reset();
  priceInput.dataset.autofilled = 'false';
  lastFetchedTicker = '';
  priceHint.innerHTML = '💡 填股號後會自動帶入「昨日收盤價」，你可以再改成實際成交價';
}

document.getElementById('position-form').addEventListener('submit', async e => {
  e.preventDefault();
  const ticker = document.getElementById('input-ticker').value.trim().toUpperCase();
  const buyPrice = parseFloat(document.getElementById('input-buy-price').value);
  const buyDate = document.getElementById('input-buy-date').value;
  const timeframe = document.getElementById('input-timeframe').value;
  const swingLow = document.getElementById('input-swing-low').value || null;
  if (!ticker || !buyPrice || !buyDate) return;
  const btn = document.getElementById('submit-btn');
  btn.textContent = '新增中...'; btn.disabled = true;
  try {
    await savePosition({ ticker, buyPrice, buyDate, timeframe, swingLow, stockName: pendingStockName || '' });
    pendingStockName = '';
    closeModal();
  } catch (err) {
    alert('新增失敗：' + err.message);
  } finally {
    btn.textContent = '確認新增'; btn.disabled = false;
  }
});

// ── Detail ──
async function openDetail(pos) {
  detailPos = pos;
  detailK = pos.data.kValue || (pos.data.timeframe === 'short' ? 2.0 : 3.0);
  showScreen('detail');
  document.getElementById('detail-body').innerHTML = '<div class="loading-state"><div>⏳</div><p>抓取股價中...</p></div>';

  // 新聞並行抓，不擋頁面
  const newsPromise = fetchNews(pos.data.ticker, pos.data.stockName);

  const result = await fetchCandles(pos.data.ticker);
  if (!result) {
    document.getElementById('detail-body').innerHTML = '<div class="error-state"><div>⚠️</div><p>無法取得資料，請確認股號是否正確</p></div>';
    return;
  }
  detailCandles = result.candles;
  detailMeta = result.meta;
  renderDetail();

  // 股名抓到後用更準的關鍵字再補抓一次新聞（如果第一次沒有結果或股名是空的時候）
  const finalName = detailMeta?.name || pos.data.stockName;
  newsPromise.then(news => {
    const container = document.getElementById('news-container');
    const metaEl = document.getElementById('news-meta');
    if (!container) return;
    if (news.length === 0 && finalName && finalName !== pos.data.stockName) {
      fetchNews(pos.data.ticker, finalName).then(n2 => {
        renderNewsList(container, n2);
        if (metaEl) metaEl.textContent = n2.length ? `${n2.length} 則` : '無';
      });
    } else {
      renderNewsList(container, news);
      if (metaEl) metaEl.textContent = news.length ? `${news.length} 則` : '無';
    }
  });
}

function renderDetail() {
  const sig = calculateAllSignals(detailPos.data, detailCandles, detailK);
  const { data } = detailPos;
  const gainClass = sig.gain >= 0 ? 'gain' : 'loss';
  const gainStr = (sig.gain >= 0 ? '+' : '') + sig.gain.toFixed(2) + '%';

  const stockName = detailMeta?.name || data.stockName || '';
  document.getElementById('detail-body').innerHTML = `
    <div class="summary-card">
      <div class="summary-head">
        <div>
          <div class="summary-ticker">${data.ticker} <span class="summary-name">${stockName}</span></div>
          <div class="summary-meta">${data.timeframe === 'short' ? '短線' : '中長線'} · 買進日 ${data.buyDate}</div>
        </div>
      </div>
      <div class="summary-grid">
        <div class="stat-item"><label>現價</label><div class="stat-value">${sig.currentPrice.toFixed(2)}</div></div>
        <div class="stat-item"><label>損益</label><div class="stat-value ${gainClass}">${gainStr}</div></div>
        <div class="stat-item"><label>買進價</label><div class="stat-value">${Number(data.buyPrice).toFixed(2)}</div></div>
        <div class="stat-item"><label>ATR(14)</label><div class="stat-value">${sig.atr ? sig.atr.toFixed(2) : 'N/A'}</div></div>
      </div>
      <div class="data-date">資料日期：${sig.dataDate}</div>
    </div>

    <div class="chart-card">
      <div class="card-head"><span>📈 近 30 日 K 線</span><span class="head-meta">紅漲綠跌 · 點擊查價</span></div>
      <div id="kline-container"></div>
      <div class="kline-detail" id="kline-detail"></div>
    </div>

    <div class="news-card">
      <div class="card-head"><span>📰 相關新聞</span><span class="head-meta" id="news-meta">載入中...</span></div>
      <div id="news-container"><div style="color:var(--muted);text-align:center;padding:20px;font-size:13px">抓取中 ⏳</div></div>
    </div>

    <div class="slider-card">
      <div class="slider-head">
        <span class="slider-title">ATR 乘數（k）</span>
        <span class="k-display" id="k-display">${detailK.toFixed(1)}</span>
      </div>
      <div class="slider-hints"><span>1.0 緊</span><span>4.0 寬</span></div>
      <input type="range" id="k-slider" min="1" max="4" step="0.1" value="${detailK}">
      <div class="slider-desc">k 越大，停損停利點離現價越遠，給股票更多呼吸空間，但反轉時吐回較多。短線建議 1.5–2，中長線建議 2.5–3。停利線 k 自動為停損線 k × 1.3。</div>
    </div>

    <div class="explain-box">
      <strong>📕 怎麼看這頁？</strong>
      <p>下面有兩排卡片：</p>
      <ul>
        <li><b style="color:var(--red)">紅色（停損）</b>：跌到這個價要賣，<b>避免越虧越多</b></li>
        <li><b style="color:var(--green)">綠色（停利）</b>：漲到這個價要賣，<b>鎖住已經賺到的錢</b></li>
      </ul>
      <p>每張卡片是不同的判斷方法。<b>任何一張變紅或變綠都是出場訊號</b>。專業交易員會多種方法疊著看，越多訊號同時亮越要嚴肅看待。</p>
    </div>

    <div class="section-label">🔻 停損訊號（虧錢時保命）</div>
    <div class="signals-list" id="stop-list"></div>

    <div class="section-label">🔺 停利訊號（賺錢時鎖利）</div>
    <div class="signals-list" id="profit-list"></div>

    <div style="height:40px"></div>`;

  fillSignals(sig);
  renderKLine(document.getElementById('kline-container'), document.getElementById('kline-detail'), detailCandles, 30);

  document.getElementById('k-slider').addEventListener('input', e => {
    detailK = parseFloat(e.target.value);
    document.getElementById('k-display').textContent = detailK.toFixed(1);
    fillSignals(calculateAllSignals(detailPos.data, detailCandles, detailK));
  });
}

function fillSignals(sig) {
  const stopList = document.getElementById('stop-list');
  const profitList = document.getElementById('profit-list');
  if (!stopList || !profitList) return;
  stopList.innerHTML = '';
  profitList.innerHTML = '';
  sig.stopSignals.forEach(s => stopList.appendChild(makeSignalCard(s, 'stop')));
  sig.profitSignals.forEach(s => profitList.appendChild(makeSignalCard(s, 'profit')));
}

function makeSignalCard(s, type) {
  const el = document.createElement('div');
  el.className = 'signal-card';
  let cls = '', stCls = 'st-ok', stTxt = s.okLabel;
  if (s.triggered) {
    if (type === 'stop') { cls = s.isTime ? 'trig-time' : 'trig-stop'; stCls = s.isTime ? 'st-yellow' : 'st-red'; }
    else { cls = 'trig-profit'; stCls = 'st-green'; }
    stTxt = s.triggerLabel;
  }
  if (cls) el.classList.add(cls);

  let priceHtml;
  if (s.isTime) {
    priceHtml = `<div class="sig-price">${s.days}<span style="font-size:14px;font-weight:400"> / ${s.limit} 天</span></div>`;
  } else if (s.price != null) {
    priceHtml = `<div class="sig-price">${s.price.toFixed(2)}</div>`;
  } else {
    priceHtml = `<div class="sig-price" style="font-size:13px;color:var(--muted)">資料不足</div>`;
  }

  el.innerHTML = `
    <div class="sig-left">
      <div class="sig-name">${s.label}</div>
      <div class="sig-desc">${s.desc}</div>
    </div>
    <div class="sig-right">
      ${priceHtml}
      <div class="sig-status ${stCls}">${stTxt}</div>
    </div>`;
  return el;
}

document.getElementById('back-btn').addEventListener('click', () => showScreen('dashboard'));

document.getElementById('delete-position-btn').addEventListener('click', async () => {
  if (!detailPos) return;
  if (!confirm(`確定刪除 ${detailPos.data.ticker} 這筆持倉？`)) return;
  await removePosition(detailPos.id);
  showScreen('dashboard');
});
