/* 账单文件解码：微信账单 CSV 是 UTF-8（手动解码，不依赖 TextDecoder）；
 * 支付宝账单多为 GBK，优先用运行时自带 TextDecoder，没有则返回 null 由上层给指引。 */
function utf8Decode(buf) {
  var bytes = new Uint8Array(buf), out = [], i = 0, c, c2, c3, c4, cp;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
  while (i < bytes.length) {
    c = bytes[i];
    if (c < 0x80) { out.push(String.fromCharCode(c)); i += 1; }
    else if (c >= 0xC2 && c <= 0xDF) { c2 = bytes[i + 1]; out.push(String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F))); i += 2; }
    else if (c >= 0xE0 && c <= 0xEF) { c2 = bytes[i + 1]; c3 = bytes[i + 2]; out.push(String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F))); i += 3; }
    else if (c >= 0xF0 && c <= 0xF4) {
      c2 = bytes[i + 1]; c3 = bytes[i + 2]; c4 = bytes[i + 3];
      cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F);
      cp -= 0x10000;
      out.push(String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))); i += 4;
    } else { return null; } /* 非法 UTF-8 序列 */
  }
  return out.join("");
}
function looksLikeBill(s) { return s && s.indexOf("交易对方") >= 0 && s.indexOf("金额") >= 0; }
function decodeBillBuffer(buf) {
  var s = utf8Decode(buf);
  if (looksLikeBill(s)) return s;
  if (typeof TextDecoder !== "undefined") {
    try { var g = new TextDecoder("gbk").decode(buf); if (looksLikeBill(g)) return g; } catch (e) {}
  }
  return null;
}
module.exports = { decodeBillBuffer: decodeBillBuffer, utf8Decode: utf8Decode };
