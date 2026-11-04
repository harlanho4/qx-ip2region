/*
 * Quantumult X · IP2Region HTTP Request
 * [task_local]
 * event-interaction https://qx-ip2region.harlanho4.workers.dev/task.js, tag=GeoIP 查询, img-url=location.fill.viewfinder.system, enabled=true
 *
 * IPv4-only lookup: discover egress IPv4 through selected policy using
 * ipify's IPv4-specific endpoint, then locate it in our R2-backed XDB.
 * The original /geo and /qx.js keep their current dual-stack behavior.
 */
var geoNode = typeof $environment !== "undefined" && $environment &&
              typeof $environment.params === "string"
  ? $environment.params.trim() : "";
var geoStart = Date.now();
var geoDetect = {
  url: "https://api.ipify.org?format=json",
  timeout: 5000
};
if (geoNode) geoDetect.opts = { policy: geoNode };
var geoExpectedIP = "";

function isIPv4(value) {
  if (typeof value !== "string") return false;
  var parts = value.split(".");
  if (parts.length !== 4) return false;
  for (var i = 0; i < 4; i++) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i]) || Number(parts[i]) > 255) return false;
  }
  return true;
}

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
  if (!isIPv4(ip) || ip !== geoExpectedIP) throw new Error("IPv4 结果不匹配");

  var places = [];
  if (province && province !== country) places.push(province);
  if (city && city !== province && city !== country) places.push(city);
  var location = places.join(" · ") || country;
  var family = "IPv4";
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
function geoLookup(ip) {
  var request = {
    url: "https://qx-ip2region.harlanho4.workers.dev/lookup4?ip=" + encodeURIComponent(ip),
    timeout: 6000
  };
  // Keep both requests on the selected Quantumult X policy.
  if (geoNode) request.opts = { policy: geoNode };
  return $task.fetch(request).then(function (response) {
    var status = Number(response && (response.statusCode || response.status));
    if (status !== 200) throw new Error("ip2region HTTP " + (status || "未知"));
    var data = JSON.parse(response.body || "{}");
    if (data.status !== "success") throw new Error("ip2region 数据暂不可用");
    geoPanel(data);
  });
}
try {
  $task.fetch(geoDetect).then(function (response) {
    var status = Number(response && (response.statusCode || response.status));
    if (status !== 200) throw new Error("IPv4 检测 HTTP " + (status || "未知"));
    var detected = JSON.parse(response.body || "{}").ip;
    if (!isIPv4(detected)) throw new Error("节点没有返回有效的 IPv4");
    geoExpectedIP = detected;
    return geoLookup(detected);
  }).catch(function (error) {
    geoFail(error && error.message ? error.message : "IPv4 查询超时");
  });
} catch (error) {
  geoFail(error && error.message ? error.message : "查询启动失败");
}