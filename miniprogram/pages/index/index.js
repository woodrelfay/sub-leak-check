const SL = require("../../utils/core.js");
const DEMO = require("../../utils/demo-data.js");
const { decodeBillBuffer } = require("../../utils/decode.js");

function toTxns(list) {
  return list.map(function (t) {
    return {
      date: new Date(String(t.date).replace(" ", "T")),
      counterparty: t.counterparty, product: t.product,
      direction: t.direction, amount: t.amount, source: t.source
    };
  });
}

Page({
  data: {
    mode: "demo",
    subCount: 0, allTotal: "¥0.00", suspectTotal: "¥0.00",
    subs: [], rangeText: "", err: ""
  },

  onLoad: function () { this.applyReport(toTxns(DEMO), "demo"); },

  applyReport: function (txns, mode) {
    txns.sort(function (a, b) { return a.date - b.date; });
    const r = SL.detectSubscriptions(txns);
    this._report = r;
    this._range = { from: txns[0].date, to: txns[txns.length - 1].date };
    this.setData({
      mode: mode,
      subCount: r.subCount,
      allTotal: SL.fmtMoney(r.allTotal),
      suspectTotal: SL.fmtMoney(r.suspectTotal),
      rangeText: SL.fmtDate(this._range.from) + " ~ " + SL.fmtDate(this._range.to),
      subs: r.subscriptions.map(function (s) {
        return {
          name: s.name, category: s.category, cadence: s.cadence,
          count: s.count, monthCount: s.monthCount,
          total: SL.fmtMoney(s.total), lastText: SL.fmtDate(s.lastDate) + " · " + SL.fmtMoney(s.lastAmount),
          flags: s.flags.map(function (f) { return { text: f, gray: f.indexOf("连续") === 0 }; })
        };
      })
    });
    this.drawCard();
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
    this.applyReport(all, "mine");
    wx.showToast({ title: "体检完成", icon: "success" });
  },

  backDemo: function () { this.setData({ err: "" }); this.applyReport(toTxns(DEMO), "demo"); },

  drawCard: function () {
    const r = this._report, range = this._range;
    if (!r) return;
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
      ctx.strokeStyle = "#dce8e2"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(64, 570); ctx.lineTo(W - 64, 570); ctx.stroke();
      let y = 660;
      ctx.font = "700 36px sans-serif"; ctx.fillStyle = "#1d2b26";
      ctx.fillText("扣得最多的 5 个", 64, y); y += 66;
      r.subscriptions.slice(0, 5).forEach(function (s, i) {
        ctx.font = "400 38px sans-serif"; ctx.fillStyle = "#1d2b26";
        ctx.fillText((i + 1) + ". " + s.name, 64, y);
        ctx.textAlign = "right"; ctx.font = "700 38px sans-serif";
        ctx.fillText(SL.fmtMoney(s.total), W - 64, y);
        ctx.textAlign = "left"; ctx.font = "400 28px sans-serif"; ctx.fillStyle = "#6b7d75";
        ctx.fillText(s.monthCount + " 个月 · " + (s.flags.length ? s.flags.join(" · ") : s.cadence), 96, y + 44);
        y += 118;
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
