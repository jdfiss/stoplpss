function parseYahooData(raw) {
  const result = raw.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split('T')[0],
    open: q.open?.[i], high: q.high?.[i],
    low: q.low?.[i], close: q.close?.[i]
  })).filter(c => c.close != null && c.high != null && c.low != null);
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function calculateMA(candles, period) {
  if (candles.length < period) return null;
  return candles.slice(-period).reduce((s, c) => s + c.close, 0) / period;
}

function calculateSAR(candles, iAF = 0.02, step = 0.02, maxAF = 0.20) {
  if (candles.length < 5) return null;
  const init = candles.slice(0, 5);
  let bull = init[4].close > init[0].close;
  let EP = bull ? Math.max(...init.map(c => c.high)) : Math.min(...init.map(c => c.low));
  let AF = iAF;
  let SAR = bull ? Math.min(...init.map(c => c.low)) : Math.max(...init.map(c => c.high));

  for (let i = 1; i < candles.length; i++) {
    let ns = SAR + AF * (EP - SAR);
    if (bull) {
      ns = i >= 2 ? Math.min(ns, candles[i-1].low, candles[i-2].low) : Math.min(ns, candles[i-1].low);
      if (candles[i].low <= ns) {
        bull = false; ns = EP; EP = candles[i].low; AF = iAF;
      } else if (candles[i].high > EP) {
        EP = candles[i].high; AF = Math.min(AF + step, maxAF);
      }
    } else {
      ns = i >= 2 ? Math.max(ns, candles[i-1].high, candles[i-2].high) : Math.max(ns, candles[i-1].high);
      if (candles[i].high >= ns) {
        bull = true; ns = EP; EP = candles[i].high; AF = iAF;
      } else if (candles[i].low < EP) {
        EP = candles[i].low; AF = Math.min(AF + step, maxAF);
      }
    }
    SAR = ns;
  }
  return { sar: SAR, bullish: bull };
}

function getHighestSince(candles, entryDate) {
  const after = candles.filter(c => c.date >= entryDate);
  return after.length ? Math.max(...after.map(c => c.high)) : null;
}

function countTradingDays(candles, entryDate) {
  return candles.filter(c => c.date > entryDate).length;
}

function calculateAllSignals(pos, candles, k) {
  const { buyPrice, buyDate, timeframe, swingLow } = pos;
  const isShort = timeframe === 'short';
  const last = candles[candles.length - 1];
  const currentPrice = last.close;
  const dataDate = last.date;

  const atr = calculateATR(candles);
  const ma10 = calculateMA(candles, 10);
  const ma20 = calculateMA(candles, 20);
  const sar = calculateSAR(candles);
  const highest = getHighestSince(candles, buyDate);
  const days = countTradingDays(candles, buyDate);
  const timeLimit = isShort ? 5 : 10;
  const maLevel = isShort ? ma10 : ma20;
  const maLabel = isShort ? 'MA10' : 'MA20';
  const kTrail = Math.min(k * 1.3, 4.0);
  const pct = isShort ? 0.10 : 0.20;
  const gain = ((currentPrice - buyPrice) / buyPrice) * 100;

  const atrStopPrice = atr != null ? buyPrice - k * atr : null;
  const atrTrailPrice = (atr != null && highest != null) ? highest - kTrail * atr : null;

  return {
    currentPrice, dataDate, gain, atr, days, timeLimit, highest,
    stopSignals: [
      {
        id: 'hardStop', label: '🛡 硬停損 -7%', isTime: false,
        desc: '虧損 7% 一律砍倉。這是「最後一道保險」，無論發生什麼事，跌到這就是要賣。',
        price: buyPrice * 0.93,
        triggered: currentPrice <= buyPrice * 0.93,
        triggerLabel: '⚠ 已跌破，建議砍倉', okLabel: '✓ 安全'
      },
      {
        id: 'atrStop', label: '📐 ATR 停損', isTime: false,
        desc: atr != null
          ? `用個股「平均波動度」算出的合理停損。買進價 − ${k.toFixed(1)}×ATR(${atr.toFixed(2)})。波動大的股票會自動拉開停損距離，避免被洗出場。`
          : '需要 15 天以上股價資料才能計算',
        price: atrStopPrice,
        triggered: atrStopPrice != null && currentPrice <= atrStopPrice,
        triggerLabel: '⚠ 已跌破', okLabel: '✓ 安全'
      },
      swingLow ? {
        id: 'swingLow', label: '🧱 前波低點', isTime: false,
        desc: '你設定的「結構防守線」。跌破代表市場集體共識被破壞，是經典停損訊號。',
        price: parseFloat(swingLow),
        triggered: currentPrice <= parseFloat(swingLow),
        triggerLabel: '⚠ 結構破壞', okLabel: '✓ 結構完整'
      } : null,
      {
        id: 'maStop', label: `📉 ${maLabel} 破線停損`, isTime: false,
        desc: `${maLabel} = 最近 ${isShort ? 10 : 20} 天的平均收盤價。跌破代表短期趨勢轉弱，多頭結構鬆動。`,
        price: maLevel,
        triggered: maLevel != null && currentPrice < maLevel,
        triggerLabel: '⚠ 已跌破均線', okLabel: '✓ 站上均線'
      },
      {
        id: 'timeStop', label: '⏰ 時間停損', isTime: true,
        desc: `進場後 ${timeLimit} 個交易日內沒發動就出場。動能策略最怕「死魚盤」，把資金抽出來換更有效率的標的。`,
        price: null, days, limit: timeLimit,
        triggered: days >= timeLimit,
        triggerLabel: `⚠ 第 ${days} 天，已到期`, okLabel: `第 ${days} / ${timeLimit} 天，OK`
      }
    ].filter(Boolean),
    profitSignals: [
      {
        id: 'atrTrail', label: '🎯 ATR 移動停利', isProfit: true,
        desc: (atr != null && highest != null)
          ? `從進場後最高價 ${highest.toFixed(2)} 往下扣 ${kTrail.toFixed(1)}×ATR。漲越多這個價也跟著往上，鎖住已經賺到的利潤。`
          : '需要進場後的股價資料',
        price: atrTrailPrice,
        triggered: atrTrailPrice != null && currentPrice > buyPrice && currentPrice <= atrTrailPrice,
        triggerLabel: '✓ 觸發鎖利', okLabel: '✓ 持有中'
      },
      {
        id: 'sar', label: '🌀 拋物線 SAR', isProfit: true,
        desc: sar
          ? (sar.bullish ? '自動追蹤趨勢的支撐點。目前趨勢向上，SAR 在股價下方撐著。跌破 SAR = 趨勢結束。' : '⚠ SAR 已翻空，自動追蹤判定趨勢反轉。')
          : '資料不足',
        price: sar?.sar ?? null,
        triggered: sar != null && !sar.bullish,
        triggerLabel: '⚠ 趨勢翻空', okLabel: '✓ 趨勢向上'
      },
      {
        id: 'pctTarget', label: `💰 目標獲利 +${(pct * 100).toFixed(0)}%`, isProfit: true,
        desc: `${isShort ? '短線設 +10%' : '中長線設 +20%'} 為固定目標。漲到這價先賣一部分（例如賣一半），剩下交給移動停利去跑。`,
        price: buyPrice * (1 + pct),
        triggered: currentPrice >= buyPrice * (1 + pct),
        triggerLabel: '✓ 已達目標！可考慮減碼',
        okLabel: `距目標還差 ${Math.max(0, ((buyPrice * (1 + pct) - currentPrice) / currentPrice * 100)).toFixed(1)}%`
      }
    ]
  };
}
