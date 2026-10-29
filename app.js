/* sub-leak-check 页面逻辑：读文件（UTF-8 失败回退 GBK）→ 解析 → 渲染结果 → 画报告卡。
 * 不发起任何网络请求。 */
(function () {
  "use strict";
  var SL = window.SubLeak;
  var drop = document.getElementById("drop"), fileInput = document.getElementById("file");
  var errBox = document.getElementById("err"), result = document.getElementById("result");
  var allTxns = [], lastReport = null, lastRange = null;

  function showErr(msg) { errBox.textContent = msg; errBox.style.display = "block"; }
  function hideErr() { errBox.style.display = "none"; }

  function decodeBuffer(buf) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("gbk").decode(buf); }
  }

  function handleFiles(files) {
    hideErr();
    var pending = files.length, failed = [];
    Array.prototype.forEach.call(files, function (f) {
      f.arrayBuffer().then(function (buf) {
        var bill = SL.normalizeBill(decodeBuffer(buf));
        if (bill.ok && bill.txns.length) { allTxns = allTxns.concat(bill.txns); }
        else { failed.push(f.name + "：" + (bill.error || "没有可用记录")); }
        if (--pending === 0) finishLoad(failed);
      }).catch(function () { failed.push(f.name + "：读取失败"); if (--pending === 0) finishLoad(failed); });
    });
  }

  function finishLoad(failed) {
    if (!allTxns.length) { if (failed.length) showErr(failed.join("；")); return; }
    if (failed.length) showErr("部分文件没读成（" + failed.join("；") + "），先用读成的部分体检");
    allTxns.sort(function (a, b) { return a.date - b.date; });
    render();
  }

  function render() {
    var report = SL.detectSubscriptions(allTxns);
    lastReport = report;
    lastRange = { from: allTxns[0].date, to: allTxns[allTxns.length - 1].date };
    document.getElementById("stCount").textContent = report.subCount + " 个";
    document.getElementById("stAll").textContent = SL.fmtMoney(report.allTotal);
    document.getElementById("stSuspect").textContent = SL.fmtMoney(report.suspectTotal);
    var tb = document.getElementById("tbody");
    tb.innerHTML = "";
    if (!report.subscriptions.length) {
      tb.innerHTML = '<tr><td colspan="5">没识别出固定周期扣款——可能账单时间段太短（建议满 6 个月以上），或你的订阅不在这份账单里</td></tr>';
    }
    report.subscriptions.forEach(function (s) {
      var tr = document.createElement("tr");
      var flags = s.flags.map(function (f) {
        return '<span class="flag' + (f.indexOf("连续") === 0 ? " gray" : "") + '">' + f + "</span>";
      }).join("");
      tr.innerHTML = "<td><b>" + esc(s.name) + "</b><br><span style='color:#8a7f6a;font-size:12px'>最近一次 " +
        SL.fmtDate(s.lastDate) + " · " + SL.fmtMoney(s.lastAmount) + "</span></td>" +
        "<td>" + esc(s.category) + "</td>" +
        "<td>" + s.cadence + " · " + s.count + " 笔<br><span style='color:#8a7f6a;font-size:12px'>" + s.monthCount + " 个月</span></td>" +
        "<td><b>" + SL.fmtMoney(s.total) + "</b></td><td>" + (flags || "—") + "</td>";
      tb.appendChild(tr);
    });
    result.style.display = "block";
    drawCard(report, lastRange);
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---------- 报告卡（1080×1440，纯 Canvas，无外部库） ---------- */
  function drawCard(report, range) {
    var cv = document.getElementById("card"), ctx = cv.getContext("2d");
    var W = 1080, H = 1440;
    ctx.fillStyle = "#fff7ea"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#d93a2b"; ctx.fillRect(0, 0, W, 190);
    ctx.fillStyle = "#ffffff"; ctx.textAlign = "left";
    ctx.font = "800 64px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText("我的订阅漏钱体检", 64, 96);
    ctx.font = "400 30px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText("账单期 " + SL.fmtDate(range.from) + " ~ " + SL.fmtDate(range.to) + " · 共识别 " + report.subCount + " 个自动续费", 64, 152);

    ctx.fillStyle = "#8a7f6a"; ctx.font = "400 34px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText("疑似漏钱（重复订阅 + 悄悄涨价）", 64, 300);
    ctx.fillStyle = "#d93a2b"; ctx.font = "800 130px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText(SL.fmtMoney(report.suspectTotal), 60, 440);
    ctx.fillStyle = "#26221c"; ctx.font = "400 36px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText("持续扣费总额 " + SL.fmtMoney(report.allTotal) + "，逐条确认后再关", 64, 520);

    ctx.strokeStyle = "#e8dcc4"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(64, 570); ctx.lineTo(W - 64, 570); ctx.stroke();

    var y = 660;
    ctx.font = "700 36px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillStyle = "#26221c"; ctx.fillText("扣得最多的 5 个", 64, y); y += 66;
    report.subscriptions.slice(0, 5).forEach(function (s, i) {
      ctx.font = "400 38px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
      ctx.fillStyle = "#26221c";
      ctx.fillText((i + 1) + ". " + s.name, 64, y);
      ctx.textAlign = "right";
      ctx.font = "700 38px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
      ctx.fillText(SL.fmtMoney(s.total), W - 64, y);
      ctx.textAlign = "left";
      ctx.font = "400 28px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
      ctx.fillStyle = "#8a7f6a";
      var tag = s.flags.length ? s.flags.join(" · ") : s.cadence;
      ctx.fillText(s.monthCount + " 个月 · " + tag, 96, y + 44);
      y += 118;
    });

    ctx.fillStyle = "#26221c"; ctx.fillRect(0, H - 170, W, 170);
    ctx.fillStyle = "#ffffff"; ctx.font = "700 36px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText("订阅漏钱体检 · sub-leak-check", 64, H - 96);
    ctx.font = "400 28px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillStyle = "#cfc4ab";
    ctx.fillText("账单全程未离开我的浏览器 · 你也来测测漏了多少", 64, H - 46);
  }

  drop.addEventListener("click", function () { fileInput.click(); });
  document.getElementById("pick").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () { if (fileInput.files.length) handleFiles(fileInput.files); });
  ["dragover", "dragenter"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  document.getElementById("demo").addEventListener("click", function () {
    hideErr();
    allTxns = window.DEMO_TXNS.map(function (t) {
      return { date: new Date(t.date.replace(" ", "T")), counterparty: t.counterparty, product: t.product, direction: t.direction, amount: t.amount, source: t.source };
    });
    render();
  });
  document.getElementById("dlCard").addEventListener("click", function () {
    var a = document.createElement("a");
    a.download = "订阅漏钱体检报告卡.png";
    a.href = document.getElementById("card").toDataURL("image/png");
    a.click();
  });
})();
