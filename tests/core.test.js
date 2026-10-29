/* 核心逻辑单测：node tests/core.test.js（零依赖） */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const SL = require("../core.js");

function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("gbk").decode(buf); }
}

// 1) 微信示例账单（虚构数据，数字为手工核算值）
const wx = SL.normalizeBill(decode(fs.readFileSync(path.join(__dirname, "..", "samples", "wechat-sample.csv"))));
assert.strictEqual(wx.ok, true, "wechat parse ok");
assert.strictEqual(wx.source, "wechat");
assert.strictEqual(wx.txns.length, 74, "wechat txn count");
const r1 = SL.detectSubscriptions(wx.txns);
assert.strictEqual(r1.subCount, 7, "wechat sub count");
assert.strictEqual(r1.allTotal, 1665, "wechat all total");
assert.strictEqual(r1.dupExtraTotal, 300, "dup: 腾讯视频与优酷同品类重复，保留单价高者");
assert.strictEqual(r1.hikeTotal, 35, "hike: 优酷 25→30，7 笔各多收 5");
assert.strictEqual(r1.suspectTotal, 335, "suspect = dup + hike");
const youku = r1.subscriptions.find(s => s.name.includes("优酷"));
assert.ok(youku.flags.includes("悄悄涨价"), "youku hike flag");
const tencent = r1.subscriptions.find(s => s.name.includes("腾讯视频"));
assert.ok(tencent.flags.includes("同品类重复"), "tencent dup flag");

// 2) 支付宝示例账单（GBK 编码）
const ali = SL.normalizeBill(decode(fs.readFileSync(path.join(__dirname, "..", "samples", "alipay-sample.csv"))));
assert.strictEqual(ali.ok, true, "alipay parse ok");
assert.strictEqual(ali.txns.length, 16, "alipay txn count");
const r2 = SL.detectSubscriptions(ali.txns);
assert.strictEqual(r2.subCount, 2, "alipay sub count");
assert.strictEqual(r2.allTotal, 280, "alipay all total");
assert.strictEqual(r2.suspectTotal, 0, "alipay no suspect");

// 3) 坏输入要有明确报错，不能崩
const bad = SL.normalizeBill("hello,world\n1,2");
assert.strictEqual(bad.ok, false);
assert.ok(bad.error.length > 0);

// 4) 一次性消费不能被误判成订阅
const oneOff = SL.normalizeBill([
  "微信支付账单明细", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",
  "2026-01-05 10:00:00,商户消费,海底捞,/,支出,268.00,零钱,支付成功,1,1,/",
  "2026-02-05 10:00:00,商户消费,海底捞,/,支出,268.00,零钱,支付成功,2,2,/",
].join("\n"));
assert.strictEqual(oneOff.ok, true);
const r4 = SL.detectSubscriptions(oneOff.txns);
assert.strictEqual(r4.subCount, 0, "同额两笔餐饮不算订阅（不足3个月且非词典商户）");

console.log("all tests passed");
