const SL = require("../../utils/core.js");
const DEMO = require("../../utils/demo-data.js");
const { decodeBillBuffer } = require("../../utils/decode.js");

const STATUS_LABELS = {
  pending: "待确认",
  keep: "还在用",
  planned: "准备关闭",
  done: "已关闭"
};

function toTxns(list) {
  return list.map(function (t) {
    return {
      date: new Date(String(t.date).replace(" ", "T")),
      counterparty: t.counterparty, product: t.product,
      direction: t.direction, amount: t.amount, source: t.source
    };
  });
}

function sourceLabel(source) {
  if (source === "wechat") return "微信账单";
  if (source === "alipay") return "支付宝账单";
  if (source === "demo") return "示例账单";
  return source || "账单";
}

Page({
  data: {
    mode: "demo",
    subCount: 0, allTotal: "¥0.00", suspectTotal: "¥0.00",
    subs: [], rangeText: "", err: "",
    pendingCount: 0, keepCount: 0, plannedCount: 0, doneCount: 0,
    plannedAnnual: "¥0.00", doneAnnual: "¥0.00", excludedCount: 0
  },

  onLoad: function () { this.setBill(toTxns(DEMO), "demo"); },

  setBill: function (txns, mode) {
    txns.sort(function (a, b) { return a.date - b.date; });
    this._txns = txns;
    this._mode = mode;
    this._excluded = {};
    this._checklist = {};
    this._expanded = {};
    this._range = txns.length ? { from: txns[0].date, to: txns[txns.length - 1].date } : null;
    this.refreshReport();
  },

  refreshReport: function () {
    const that = this;
    const excluded = this._excluded || {};
    const filtered = (this._txns || []).filter(function (t) {
      return !excluded[SL.groupKeyForTxn(t)];
    });
    const r = SL.detectSubscriptions(filtered);
    this._report = r;

    let pendingCount = 0, keepCount = 0, plannedCount = 0, doneCount = 0;
    let plannedAnnual = 0, doneAnnual = 0;

    const subs = r.subscriptions.map(function (s) {
      const status = (that._checklist && that._checklist[s.key]) || "pending";
      if (status === "keep") keepCount++;
      else if (status === "planned") { plannedCount++; plannedAnnual += s.annualCost || 0; }
      else if (status === "done") { doneCount++; doneAnnual += s.annualCost || 0; }
      else pendingCount++;

      return {
        key: s.key,
        name: s.name, category: s.category, cadence: s.cadence,
        count: s.count, monthCount: s.monthCount,
        total: SL.fmtMoney(s.total),
        lastText: SL.fmtDate(s.lastDate) + " · " + SL.fmtMoney(s.lastAmount),
        firstText: SL.fmtDate(s.firstDate),
        lastDateText: SL.fmtDate(s.lastDate),
        nextText: s.nextChargeDate ? SL.fmtDate(s.nextChargeDate) : "暂不能估算",
        intervalText: s.intervalDays ? "约 " + s.intervalDays + " 天" : "不稳定",
        annualText: SL.fmtMoney(s.annualCost || 0),
        monthlyText: SL.fmtMoney(s.monthlyCost || 0),
        confidenceLabel: s.confidenceLabel,
        confidenceClass: s.confidence === "likely" ? "likely" : "suspected",
        reason: s.reason,
        cancelHint: s.cancelHint,
        status: status,
        statusLabel: STATUS_LABELS[status],
        expanded: !!(that._expanded && that._expanded[s.key]),
        flags: s.flags.map(function (f) { return { text: f, gray: f.indexOf("连续") === 0 }; }),
        charges: s.charges.map(function (c, idx) {
          return {
            id: s.key + ":" + idx,
            dateText: SL.fmtDate(c.date),
            amountText: SL.fmtMoney(c.amount),
            label: c.product && c.product !== "/" ? c.product : (c.counterparty || s.name),
            sourceText: sourceLabel(c.source)
          };
        })
      };
    });

    this._savings = { plannedAnnual: plannedAnnual, doneAnnual: doneAnnual };
    this.setData({
      mode: this._mode,
      subCount: r.subCount,
      allTotal: SL.fmtMoney(r.allTotal),
      suspectTotal: SL.fmtMoney(r.suspectTotal),
      rangeText: this._range ? SL.fmtDate(this._range.from) + " ~ " + SL.fmtDate(this._range.to) : "",
      subs: subs,
      pendingCount: pendingCount, keepCount: keepCount,
      plannedCount: plannedCount, doneCount: doneCount,
      plannedAnnual: SL.fmtMoney(plannedAnnual),
      doneAnnual: SL.fmtMoney(doneAnnual),
      excludedCount: Object.keys(excluded).length
    });
    this.drawCard();
  },

  toggleDetail: function (e) {
    const key = e.currentTarget.dataset.key;
    this._expanded[key] = !this._expanded[key];
    this.refreshReport();
  },

  setStatus: function (e) {
    const key = e.currentTarget.dataset.key;
    const status = e.currentTarget.dataset.status;
    this._checklist[key] = status;
    this.refreshReport();
  },

  markNotSubscription: function (e) {
    const key = e.currentTarget.dataset.key;
    const item = (this._report.subscriptions || []).find(function (s) { return s.key === key; });
    if (!item) return;
    const that = this;
    wx.showModal({
      title: "移出报告？",
      content: "确认「" + item.name + "」不是订阅后，这组扣款会从本次报告中移出，并重新计算总额。",
      confirmText: "移出",
      confirmColor: "#c93a2a",
      success: function (res) {
        if (!res.confirm) return;
        that._excluded[key] = true;
        delete that._checklist[key];
        that.refreshReport();
        wx.showToast({ title: "已移出并重算", icon: "success" });
      }
    });
  },

  restoreExcluded: function () {
    this._excluded = {};
    this.refreshReport();
    wx.showToast({ title: "已恢复全部项目", icon: "success" });
  },

  chooseBill: function () {
    const that = this;
    wx.chooseMessageFile({
      count: 2, type: "file", extension: ["csv"],
      success: function (res) {
        let all = [], failed = 0, pending = res.tempFiles.length;
        res.tempFiles.forEach(function (f) {
          wx.getFileSystemManager().readFile({
            filePath: f.path,
            success: function (r2) {
              const text = decodeBillBuffer(r2.data);
              const bill = text ? SL.normalizeBill(text) : { ok: false };
              if (bill.ok && bill.txns.length) all = all.concat(bill.txns); else failed++;
              if (--pending === 0) that.afterFiles(all, failed);
            },
            fail: function () { failed++; if (--pending === 0) that.afterFiles(all, failed); }
          });
        });
      }
    });
  },

  afterFiles: function (all, failed) {
    if (!all.length) {
      this.setData({ err: "没读到可用账单：请选微信/支付宝导出的 .csv（压缩包先解压后，把 csv 发到微信聊天里再来选）。支付宝 GBK 账单如读不出，可改用网页版（电脑打开更稳）" });
      return;
    }
    this.setData({ err: failed ? "有 " + failed + " 个文件没读成，先用读成的部分体检" : "" });
    this.setBill(all, "mine");
    wx.showToast({ title: "体检完成", icon: "success" });
  },

  backDemo: function () { this.setData({ err: "" }); this.setBill(toTxns(DEMO), "demo"); },

  drawCard: function () {
    const r = this._report, range = this._range;
    if (!r || !range) return;
    const doneAnnual = this._savings ? this._savings.doneAnnual : 0;
    const q = wx.createSelectorQuery();
    q.select("#card").fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node, ctx = canvas.getContext("2d");
      const W = 1080, H = 1440;
      canvas.width = W; canvas.height = H;
      ctx.fillStyle = "#f6faf8"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#0f766e"; ctx.fillRect(0, 0, W, 190);
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "left";
      ctx.font = "800 64px sans-serif";
      ctx.fillText("我的订阅体检报告", 64, 96);
      ctx.font = "400 30px sans-serif";
      ctx.fillText("账单期 " + SL.fmtDate(range.from) + " ~ " + SL.fmtDate(range.to) + " · 共识别 " + r.subCount + " 个自动续费", 64, 152);
      ctx.fillStyle = "#6b7d75"; ctx.font = "400 34px sans-serif";
      ctx.fillText("疑似多扣（重复订阅 + 悄悄涨价）", 64, 300);
      ctx.fillStyle = "#c93a2a"; ctx.font = "800 130px sans-serif";
      ctx.fillText(SL.fmtMoney(r.suspectTotal), 60, 440);
      ctx.fillStyle = "#1d2b26"; ctx.font = "400 36px sans-serif";
      ctx.fillText("持续扣费总额 " + SL.fmtMoney(r.allTotal) + "，逐条确认后再关", 64, 520);
      let listTop = 660;
      if (doneAnnual > 0) {
        ctx.fillStyle = "#0f766e"; ctx.font = "700 34px sans-serif";
        ctx.fillText("已关闭项目预计每年少扣 " + SL.fmtMoney(doneAnnual), 64, 574);
        listTop = 700;
      }
      ctx.strokeStyle = "#dce8e2"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(64, listTop - 70); ctx.lineTo(W - 64, listTop - 70); ctx.stroke();
      let y = listTop;
      ctx.font = "700 36px sans-serif"; ctx.fillStyle = "#1d2b26";
      ctx.fillText("扣得最多的 5 个", 64, y); y += 66;
      r.subscriptions.slice(0, 5).forEach(function (s, i) {
        ctx.font = "400 38px sans-serif"; ctx.fillStyle = "#1d2b26";
        ctx.fillText((i + 1) + ". " + s.name, 64, y);
        ctx.textAlign = "right"; ctx.font = "700 38px sans-serif";
        ctx.fillText(SL.fmtMoney(s.total), W - 64, y);
        ctx.textAlign = "left"; ctx.font = "400 28px sans-serif"; ctx.fillStyle = "#6b7d75";
        ctx.fillText(s.monthCount + " 个月 · " + (s.flags.length ? s.flags.join(" · ") : s.cadence), 96, y + 44);
        y += 112;
      });
      ctx.fillStyle = "#1d2b26"; ctx.fillRect(0, H - 170, W, 170);
      ctx.fillStyle = "#ffffff"; ctx.font = "700 36px sans-serif";
      ctx.fillText("订了个啥 · sub-leak-check", 64, H - 96);
      ctx.font = "400 28px sans-serif"; ctx.fillStyle = "#b9cdc4";
      ctx.fillText("账单全程未离开我的手机 · 你也来测测多扣了多少", 64, H - 46);
      this._canvas = canvas;
    }.bind(this));
  },

  saveCard: function () {
    if (!this._canvas) return;
    wx.canvasToTempFilePath({
      canvas: this._canvas, width: 1080, height: 1440, destWidth: 1080, destHeight: 1440,
      success: function (res) {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: function () { wx.showToast({ title: "已存到相册", icon: "success" }); },
          fail: function () { wx.showToast({ title: "没存成，请允许相册权限后重试", icon: "none" }); }
        });
      },
      fail: function () { wx.showToast({ title: "生成失败，请重试", icon: "none" }); }
    });
  },

  onShareAppMessage: function () {
    return { title: "订了个啥：查查你的自动续费多扣了多少（本地计算不上传）", path: "/pages/index/index" };
  }
});
