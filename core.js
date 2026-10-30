/* sub-leak-check 核心逻辑：账单解析 + 自动续费识别 + 漏钱体检报告。
 * 纯函数、无 DOM 依赖：浏览器里挂 window.SubLeak，Node 里走 module.exports 做单测。
 * 所有计算都在本地完成，不联网、不上传。 */
(function (global) {
  "use strict";

  /* ---------- CSV 解析（支持引号、转义、CRLF） ---------- */
  function parseCSV(text) {
    var rows = [], row = [], field = "", inQuotes = false, i, c;
    text = String(text).replace(/^\uFEFF/, "");
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else { field += c; }
      } else if (c === '"') { inQuotes = true; }
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* 忽略，\n 处落行 */ }
      else { field += c; }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  /* ---------- 商户词典：关键词 → 标准名/品类 ----------
   * 账单里的「交易对方/商品」写法五花八门，词典负责归一。
   * cancel: 在哪关。wechat/alipay/apple 为平台入口，app 为回对应 App 内关。 */
  var MERCHANTS = [
    { kw: ["腾讯视频"], name: "腾讯视频 VIP", cat: "视频会员" },
    { kw: ["爱奇艺"], name: "爱奇艺 VIP", cat: "视频会员" },
    { kw: ["优酷"], name: "优酷 VIP", cat: "视频会员" },
    { kw: ["芒果TV", "芒果tv"], name: "芒果TV 会员", cat: "视频会员" },
    { kw: ["哔哩哔哩", "bilibili"], name: "哔哩哔哩大会员", cat: "视频会员" },
    { kw: ["QQ音乐", "qq音乐"], name: "QQ音乐绿钻", cat: "音乐会员" },
    { kw: ["网易云音乐"], name: "网易云音乐黑胶VIP", cat: "音乐会员" },
    { kw: ["酷狗"], name: "酷狗音乐会员", cat: "音乐会员" },
    { kw: ["酷我"], name: "酷我音乐会员", cat: "音乐会员" },
    { kw: ["百度网盘"], name: "百度网盘超级会员", cat: "网盘存储" },
    { kw: ["阿里云盘"], name: "阿里云盘会员", cat: "网盘存储" },
    { kw: ["夸克"], name: "夸克网盘会员", cat: "网盘存储" },
    { kw: ["WPS", "wps"], name: "WPS 超级会员", cat: "办公工具" },
    { kw: ["剪映"], name: "剪映 VIP", cat: "创作工具" },
    { kw: ["美图秀秀", "美图"], name: "美图粉钻会员", cat: "创作工具" },
    { kw: ["Adobe", "adobe"], name: "Adobe 订阅", cat: "创作工具" },
    { kw: ["Microsoft", "微软"], name: "Microsoft 365", cat: "办公工具" },
    { kw: ["Notion"], name: "Notion Plus", cat: "办公工具" },
    { kw: ["ChatGPT", "OpenAI"], name: "ChatGPT 订阅", cat: "AI 工具" },
    { kw: ["Claude", "Anthropic"], name: "Claude 订阅", cat: "AI 工具" },
    { kw: ["微信读书"], name: "微信读书付费会员", cat: "阅读知识" },
    { kw: ["知乎"], name: "知乎盐选会员", cat: "阅读知识" },
    { kw: ["得到"], name: "得到会员", cat: "阅读知识" },
    { kw: ["喜马拉雅"], name: "喜马拉雅会员", cat: "阅读知识" },
    { kw: ["Keep"], name: "Keep 会员", cat: "运动健康" },
    { kw: ["美团"], name: "美团会员/神券", cat: "生活服务" },
    { kw: ["饿了么"], name: "饿了么超级会员", cat: "生活服务" },
    { kw: ["京东"], name: "京东 PLUS", cat: "电商会员" },
    { kw: ["淘宝", "天猫"], name: "淘宝 88VIP", cat: "电商会员" },
    { kw: ["App Store", "Apple Services", "苹果"], name: "苹果 App Store 订阅", cat: "苹果订阅", cancel: "apple" },
    { kw: ["iCloud"], name: "iCloud 存储", cat: "网盘存储", cancel: "apple" }
  ];

  function matchMerchant(counterparty, product) {
    var hay = (counterparty || "") + " " + (product || "");
    for (var i = 0; i < MERCHANTS.length; i++) {
      for (var j = 0; j < MERCHANTS[i].kw.length; j++) {
        if (hay.indexOf(MERCHANTS[i].kw[j]) >= 0) return MERCHANTS[i];
      }
    }
    return null;
  }

  /* 与 detectSubscriptions 使用同一套分组键，供界面实现“这不是订阅”后本地重算。 */
  function groupKeyForTxn(t) {
    var m = matchMerchant(t.counterparty, t.product);
    if (m) return "dict:" + m.name;
    return "gen:" + (t.counterparty || "未知") + "|" + Number(t.amount || 0).toFixed(2);
  }

  /* ---------- 账单归一化 ----------
   * 微信个人账单：表头在第 17 行，列 = 交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
   * 支付宝个人账单：GBK 编码，表头列含 交易创建时间/付款时间、交易对方、商品名称、金额(元)、收/支
   * 策略：不数行数，扫描找到表头行后按列名映射，两种格式通吃。 */
  function findHeader(rows) {
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].map(function (s) { return String(s).trim(); });
      var joined = cells.join(",");
      if (joined.indexOf("交易对方") >= 0 && (joined.indexOf("收/支") >= 0 || joined.indexOf("收/支") >= 0) &&
          (joined.indexOf("金额") >= 0)) {
        return { index: r, cells: cells };
      }
    }
    return null;
  }

  function colIndex(cells, names) {
    for (var i = 0; i < cells.length; i++) {
      for (var j = 0; j < names.length; j++) {
        if (cells[i].indexOf(names[j]) >= 0) return i;
      }
    }
    return -1;
  }

  function parseAmount(s) {
    if (s == null) return NaN;
    var v = parseFloat(String(s).replace(/[¥￥,\s]/g, ""));
    return isNaN(v) ? NaN : v;
  }

  function parseDate(s) {
    if (!s) return null;
    var m = String(s).trim().match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  function normalizeBill(text, sourceHint) {
    var rows = parseCSV(text);
    var header = findHeader(rows);
    if (!header) return { ok: false, error: "没找到账单表头：请确认拖进来的是微信/支付宝导出的 .csv 账单文件（压缩包要先解压）" };
    var cells = header.cells;
    var ci = {
      time: colIndex(cells, ["交易时间", "交易创建时间", "付款时间"]),
      counterparty: colIndex(cells, ["交易对方"]),
      product: colIndex(cells, ["商品", "商品名称"]),
      direction: colIndex(cells, ["收/支"]),
      amount: colIndex(cells, ["金额"]),
      status: colIndex(cells, ["当前状态", "交易状态"])
    };
    if (ci.time < 0 || ci.amount < 0 || ci.direction < 0) {
      return { ok: false, error: "账单列对不上：缺少时间/金额/收/支列，可能不是个人账单导出文件" };
    }
    var source = sourceHint || (cells.join(",").indexOf("交易单号") >= 0 ? "wechat" : "alipay");
    var txns = [];
    for (var r = header.index + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.length <= Math.max(ci.time, ci.amount)) continue;
      var date = parseDate(row[ci.time]);
      var amount = parseAmount(row[ci.amount]);
      if (!date || isNaN(amount)) continue;
      var dirRaw = ci.direction >= 0 ? String(row[ci.direction] || "") : "";
      var direction = dirRaw.indexOf("支") >= 0 ? "out" : (dirRaw.indexOf("收") >= 0 || dirRaw.indexOf("入") >= 0 ? "in" : "other");
      var status = ci.status >= 0 ? String(row[ci.status] || "") : "";
      if (status.indexOf("退款") >= 0 || status.indexOf("失败") >= 0 || status.indexOf("关闭") >= 0) continue;
      txns.push({
        date: date,
        counterparty: ci.counterparty >= 0 ? String(row[ci.counterparty] || "").trim() : "",
        product: ci.product >= 0 ? String(row[ci.product] || "").trim() : "",
        direction: direction,
        amount: amount,
        source: source
      });
    }
    txns.sort(function (a, b) { return a.date - b.date; });
    return { ok: true, source: source, txns: txns };
  }

  /* ---------- 续费识别 ---------- */
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function monthKey(d) { return d.getFullYear() * 100 + (d.getMonth() + 1); }

  function analyzeGroup(key, name, cat, cancel, charges) {
    charges.sort(function (a, b) { return a.date - b.date; });
    var months = {};
    charges.forEach(function (t) { months[monthKey(t.date)] = true; });
    var monthCount = Object.keys(months).length;
    var gaps = [];
    for (var i = 1; i < charges.length; i++) gaps.push(daysBetween(charges[i - 1].date, charges[i].date));
    var cadence = null;
    if (charges.length >= 2 && gaps.length) {
      var monthlyHits = gaps.filter(function (g) { return g >= 24 && g <= 42; }).length;
      var yearlyHits = gaps.filter(function (g) { return g >= 320 && g <= 410; }).length;
      if (monthlyHits >= Math.ceil(gaps.length * 0.6) && monthCount >= 3) cadence = "月付";
      else if (yearlyHits >= 1 && charges.length >= 2 && monthCount >= 2) cadence = "年付";
      else if (monthCount >= 3 && charges.length >= 3) cadence = "月度多次";
    }
    /* 高频小额按单消费不是订阅：月度多次且间隔密（中位间隔 ≤10 天）
     * 且金额零碎（最常见金额占比 <50%）时排除，例如随外卖单买的神券包。
     * 同额高频（如每月固定两次同额扣费）不受影响。 */
    if (cadence === "月度多次" && charges.length >= 10 && gaps.length) {
      var sortedGaps = gaps.slice().sort(function (a, b) { return a - b; });
      var medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
      var amountCounts = {};
      charges.forEach(function (t) { var k = t.amount.toFixed(2); amountCounts[k] = (amountCounts[k] || 0) + 1; });
      var modalCount = 0;
      Object.keys(amountCounts).forEach(function (k) { if (amountCounts[k] > modalCount) modalCount = amountCounts[k]; });
      if (medianGap <= 10 && modalCount / charges.length < 0.5) cadence = null;
    }
    var total = charges.reduce(function (s, t) { return s + t.amount; }, 0);
    var firstAmt = charges[0].amount, lastAmt = charges[charges.length - 1].amount;

    var cycleGaps = gaps;
    if (cadence === "月付") cycleGaps = gaps.filter(function (g) { return g >= 24 && g <= 42; });
    if (cadence === "年付") cycleGaps = gaps.filter(function (g) { return g >= 320 && g <= 410; });
    var sortedCycleGaps = cycleGaps.slice().sort(function (a, b) { return a - b; });
    var intervalDays = sortedCycleGaps.length ? sortedCycleGaps[Math.floor(sortedCycleGaps.length / 2)] : null;
    if (!intervalDays && cadence === "月付") intervalDays = 30;
    if (!intervalDays && cadence === "年付") intervalDays = 365;
    var nextChargeDate = null;
    if (intervalDays && cadence) {
      nextChargeDate = new Date(charges[charges.length - 1].date.getTime() + intervalDays * 86400000);
    }

    var annualCost = 0;
    if (cadence === "月付") annualCost = lastAmt * 12;
    else if (cadence === "年付") annualCost = lastAmt;
    else if (cadence === "月度多次" && monthCount > 0) annualCost = total / monthCount * 12;

    var strictHits = cadence === "月付" ? monthlyHits : (cadence === "年付" ? yearlyHits : 0);
    var strictRatio = gaps.length ? strictHits / gaps.length : 0;
    var confidence = "suspected", confidenceLabel = "疑似订阅";
    if ((cadence === "月付" || cadence === "年付") && strictRatio >= 0.6 && charges.length >= 2) {
      confidence = "likely"; confidenceLabel = "较确定";
    }
    var reason = "";
    if (cadence === "月度多次") {
      reason = monthCount + " 个月内出现 " + charges.length + " 笔同商户扣款，但不是严格的月付/年付周期，也可能是重复购买，请结合明细确认";
    } else if (cadence) {
      reason = monthCount + " 个月内出现 " + charges.length + " 笔扣款，间隔中位数约 " + intervalDays + " 天，符合" + cadence + "周期";
    }

    var sourceMap = {};
    charges.forEach(function (t) { if (t.source) sourceMap[t.source] = true; });
    var sources = Object.keys(sourceMap);
    var cancelHint = "";
    if (cancel === "apple") cancelHint = "在 iPhone「设置 → 你的名字 → 订阅」里查看和取消";
    else if (sources.indexOf("wechat") >= 0 && sources.indexOf("alipay") >= 0) cancelHint = "这组扣款同时来自微信和支付宝，请分别在微信「自动续费」和支付宝「免密支付/自动扣款」里核对";
    else if (sources.indexOf("wechat") >= 0) cancelHint = "在微信「我 → 服务 → 钱包 → 支付设置 → 自动续费」里查看和关闭";
    else if (sources.indexOf("alipay") >= 0) cancelHint = "在支付宝「我的 → 设置 → 支付设置 → 免密支付/自动扣款」里查看和关闭";
    else cancelHint = "先在微信/支付宝的自动扣款列表核对，找不到时回对应 App 的会员或订阅页查看";

    return {
      key: key, name: name, category: cat, cancel: cancel || null, cadence: cadence,
      count: charges.length, monthCount: monthCount,
      firstDate: charges[0].date, lastDate: charges[charges.length - 1].date,
      total: Math.round(total * 100) / 100,
      firstAmount: firstAmt, lastAmount: lastAmt,
      priceHike: lastAmt > firstAmt + 0.005,
      hikeExtraTotal: 0, flags: [],
      intervalDays: intervalDays, nextChargeDate: nextChargeDate,
      annualCost: Math.round(annualCost * 100) / 100,
      monthlyCost: Math.round(annualCost / 12 * 100) / 100,
      confidence: confidence, confidenceLabel: confidenceLabel, reason: reason,
      sources: sources, cancelHint: cancelHint,
      charges: charges.slice().reverse().map(function (t) {
        return {
          date: t.date, amount: t.amount, counterparty: t.counterparty || "",
          product: t.product || "", source: t.source || ""
        };
      })
    };
  }

  function detectSubscriptions(txns) {
    var groups = {}, generic = {};
    txns.filter(function (t) { return t.direction === "out"; }).forEach(function (t) {
      var m = matchMerchant(t.counterparty, t.product);
      if (m) {
        var k = "dict:" + m.name;
        (groups[k] = groups[k] || { name: m.name, cat: m.cat, cancel: m.cancel, charges: [] }).charges.push(t);
      } else {
        var gk = "gen:" + (t.counterparty || "未知") + "|" + t.amount.toFixed(2);
        (generic[gk] = generic[gk] || { name: t.counterparty || "未知商户", cat: "其他订阅", cancel: null, charges: [] }).charges.push(t);
      }
    });
    var subs = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], s = analyzeGroup(k, g.name, g.cat, g.cancel, g.charges);
      if (s.cadence) subs.push(s);
    });
    Object.keys(generic).forEach(function (k) {
      var g = generic[k], s = analyzeGroup(k, g.name, g.cat, g.cancel, g.charges);
      if (s.cadence === "月付" || s.cadence === "年付") subs.push(s); // 通用组只认严格月付/年付，防误报
    });

    /* 涨价多收的部分：按涨价后笔数 × 价差估算 */
    subs.forEach(function (s) { if (s.priceHike) s.flags.push("悄悄涨价"); });

    /* 同品类重复订阅：取最近 120 天仍在扣费的，同品类保留最新一笔金额最高者，其余标疑似 */
    var now = subs.length ? Math.max.apply(null, subs.map(function (s) { return +s.lastDate; })) : 0;
    var byCat = {};
    subs.forEach(function (s) {
      if (now - (+s.lastDate) <= 120 * 86400000) (byCat[s.category] = byCat[s.category] || []).push(s);
    });
    var dupExtraTotal = 0;
    Object.keys(byCat).forEach(function (cat) {
      var list = byCat[cat];
      if (list.length < 2 || cat === "苹果订阅" || cat === "其他订阅") return;
      list.sort(function (a, b) { return b.lastAmount - a.lastAmount; });
      list.slice(1).forEach(function (s) {
        s.flags.push("同品类重复");
        dupExtraTotal += s.total;
      });
    });

    subs.forEach(function (s) { if (s.monthCount >= 6 && s.cadence === "月付") s.flags.push("连续扣费 " + s.monthCount + " 个月"); });
    subs.sort(function (a, b) { return b.total - a.total; });

    var allTotal = subs.reduce(function (s, x) { return s + x.total; }, 0);
    var hikeTotal = subs.reduce(function (s, x) { return s + (x.priceHike ? x.hikeExtraTotal : 0); }, 0);
    var suspectTotal = Math.round((dupExtraTotal + hikeTotal) * 100) / 100;
    return {
      subscriptions: subs,
      subCount: subs.length,
      allTotal: Math.round(allTotal * 100) / 100,
      dupExtraTotal: Math.round(dupExtraTotal * 100) / 100,
      suspectTotal: suspectTotal
    };
  }

  /* 涨价多收估算需逐笔算，在 detect 前补上：按每笔与首笔价差累加正差 */
  var _detect = detectSubscriptions;
  detectSubscriptions = function (txns) {
    var byKey = {};
    txns.filter(function (t) { return t.direction === "out"; }).forEach(function (t) {
      var m = matchMerchant(t.counterparty, t.product);
      if (!m) return;
      (byKey[m.name] = byKey[m.name] || []).push(t);
    });
    var hikeMap = {};
    Object.keys(byKey).forEach(function (name) {
      var list = byKey[name].slice().sort(function (a, b) { return a.date - b.date; });
      var base = list[0].amount, extra = 0;
      list.forEach(function (t) { if (t.amount > base) extra += t.amount - base; });
      hikeMap[name] = Math.round(extra * 100) / 100;
    });
    var res = _detect(txns);
    res.subscriptions.forEach(function (s) { s.hikeExtraTotal = hikeMap[s.name] || 0; });
    var hikeTotal = res.subscriptions.reduce(function (s, x) { return s + (x.priceHike ? x.hikeExtraTotal : 0); }, 0);
    res.suspectTotal = Math.round((res.dupExtraTotal + hikeTotal) * 100) / 100;
    res.hikeTotal = Math.round(hikeTotal * 100) / 100;
    return res;
  };

  function fmtMoney(n) { return "¥" + (Math.round(n * 100) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDate(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

  global.SubLeak = {
    parseCSV: parseCSV, normalizeBill: normalizeBill, matchMerchant: matchMerchant, groupKeyForTxn: groupKeyForTxn,
    detectSubscriptions: detectSubscriptions, fmtMoney: fmtMoney, fmtDate: fmtDate, MERCHANTS: MERCHANTS
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.SubLeak;
})(typeof window !== "undefined" ? window : globalThis);
