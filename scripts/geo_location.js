/*
 * Quantumult X · IP2Region HTTP Request
 * [task_local]
 * event-interaction https://qx-ip2region.harlanho4.workers.dev/task.js, tag=GeoIP 查询, img-url=location.fill.viewfinder.system, enabled=true
 *
 * Queries the currently selected node's public egress IP using the same
 * private R2-backed ip2region database as geo_location_checker.
 */
var geoNode = typeof $environment !== "undefined" && $environment &&
              typeof $environment.params === "string"
  ? $environment.params.trim() : "";
var geoStart = Date.now();
var geoRequest = {
  url: "https://qx-ip2region.harlanho4.workers.dev/geo",
  timeout: 6000
};
if (geoNode) geoRequest.opts = { policy: geoNode };

function geoText(value) {
  if (value === null || value === undefined) return "";
  var text = String(value).trim();
  return text === "0" || text === "null" || text === "undefined" ? "" : text.slice(0, 240);
}
function geoEscape(value) {
  return geoText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function geoFlag(value) {
  var code = geoText(value).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || typeof String.fromCodePoint !== "function") return "🌐";
  return String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);
}
function geoRow(label, value) {
  return '<tr><td style="padding:10px 6px;color:#929292;white-space:nowrap;text-align:left;">' +
    geoEscape(label) + '</td><td style="padding:10px 6px;text-align:right;overflow-wrap:anywhere;">' +
    geoEscape(value || "未知") + '</td></tr>';
}
function geoPanel(body) {
  var country = geoText(body.country) || "未知地区";
  var province = geoText(body.regionName);
  var city = geoText(body.city);
  var isp = geoText(body.isp);
  var ip = geoText(body.query);
  if (!ip) throw new Error("缺少出口 IP");

  var places = [];
  if (province && province !== country) places.push(province);
  if (city && city !== province && city !== country) places.push(city);
  var location = places.join(" · ") || country;
  var family = ip.indexOf(":") === -1 ? "IPv4" : "IPv6";
  var flag = geoFlag(body.countryCode);
  var ms = Math.max(0, Date.now() - geoStart);

  var html = '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;color:inherit;padding:5px 8px;">' +
    '<div style="font-size:29px;font-weight:650;text-align:center;margin:10px 0 2px;">' +
    flag + ' ' + geoEscape(country) + '</div>' +
    '<div style="text-align:center;font-size:14px;color:#929292;margin:0 0 16px;">' +
    geoEscape(location) + '</div>' +
    '<table style="width:100%;border-collapse:collapse;border-top:1px solid rgba(128,128,128,.28);">' +
    geoRow("出口 IP", ip) +
    geoRow("网络协议", family) +
    geoRow("国家/地区", country) +
    (province && province !== country ? geoRow("省份/州", province) : "") +
    (city && city !== province ? geoRow("城市", city) : "") +
    geoRow("运营商", isp || "未知") +
    (geoNode ? geoRow("查询节点", geoNode) : "") +
    '</table><div style="text-align:center;color:#929292;font-size:12px;margin:14px 0 4px;">' +
    'ip2region · ' + ms + ' ms</div></div>';

  $done({ title: "GeoIP · " + flag + " " + country, htmlMessage: html });
}
function geoFail(reason) {
  var detail = geoEscape(reason);
  var html = '<div style="font-family:-apple-system,sans-serif;text-align:center;padding:18px;">' +
    '<div style="font-size:28px;margin-bottom:12px;">⚠️</div>' +
    '<div style="font-weight:600;">归属地查询失败</div>' +
    '<div style="color:#929292;font-size:14px;margin-top:8px;">' + detail + '</div>' +
    (geoNode ? '<div style="color:#929292;margin-top:12px;font-size:13px;">节点：' + geoEscape(geoNode) + '</div>' : "") +
    '</div>';
  $done({ title: "GeoIP · 查询失败", htmlMessage: html });
}
try {
  $task.fetch(geoRequest).then(function (response) {
    try {
      var status = Number(response && (response.statusCode || response.status));
      if (status !== 200) throw new Error("HTTP " + (status || "未知"));
      var data = JSON.parse(response.body || "{}");
      if (data.status && data.status !== "success") throw new Error("GeoIP 数据暂不可用");
      geoPanel(data);
    } catch (error) {
      geoFail(error.message || "解析失败");
    }
  }, function (error) {
    geoFail(error && error.message ? error.message : "网络连接超时");
  });
} catch (error) {
  geoFail(error && error.message ? error.message : "查询启动失败");
}