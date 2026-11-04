// ip2region XDB-backed GeoIP for Quantumult X
// Source data: https://github.com/lionsoul2014/ip2region (Apache-2.0)
const UPSTREAM = "https://api.github.com/repos/lionsoul2014/ip2region/contents/data";
const COMMIT_ENDPOINT = "https://api.github.com/repos/lionsoul2014/ip2region/commits/master";
const RAW = "https://raw.githubusercontent.com/lionsoul2014/ip2region";
const DB = {4: "ip2region_v4.xdb", 6: "ip2region_v6.xdb"};
const MIN = {4: 500000, 6: 500000};
const VECTOR_SIZE = 524288;
const HEADER_SIZE = 256;
const textDecoder = new TextDecoder();
let activeCache = null;
let activeUntil = 0;
const indexes = new Map();
// Bounded per-isolate caches. Cache keys include the immutable XDB object key,
// so a database refresh cannot reuse stale index/region data.
const SEGMENT_CACHE_BYTES = 128 * 1024;
const SEGMENT_CACHE_ENTRIES = 16;
const RESULT_CACHE_ENTRIES = 256;
const segments = new Map();
const recentRegions = new Map();

function remember(map, key, value, maxEntries) {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) map.delete(map.keys().next().value);
}

function cachedRegion(key) {
  if (!recentRegions.has(key)) return null;
  const value = recentRegions.get(key);
  remember(recentRegions, key, value, RESULT_CACHE_ENTRIES);
  return value;
}

// For large prefixes, a bounded slab read narrows multiple binary-search
// steps in one R2 operation instead of reading individual index records.
async function locateInLargeSegment(env, key, ip, version, start, count, recordSize) {
  let low = 0, high = count - 1;
  const slabRecords = Math.max(1, Math.floor(32 * 1024 / recordSize));
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const first = Math.max(low, middle - Math.floor(slabRecords / 2));
    const last = Math.min(high, first + slabRecords - 1);
    const bytes = await rangeRead(env, key, start + first * recordSize, (last - first + 1) * recordSize);
    if (compare(ip, bytes, 0, version) < 0) {
      high = first - 1;
      continue;
    }
    if (compare(ip, bytes, (last - first) * recordSize + ip.length, version) > 0) {
      low = last + 1;
      continue;
    }
    return findRecord(ip, version, bytes, recordSize);
  }
  return null;
}

function findRecord(ip, version, bytes, recordSize) {
  let low = 0, high = Math.floor(bytes.length / recordSize) - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const pos = mid * recordSize;
    const a = compare(ip, bytes, pos, version);
    const b = compare(ip, bytes, pos + ip.length, version);
    if (a < 0) high = mid - 1;
    else if (b > 0) low = mid + 1;
    else return bytes.subarray(pos, pos + recordSize);
  }
  return null;
}
const blocked = new Set(["0.0.0.0", "::", "::1"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json; charset=utf-8", "cache-control":"no-store",
      "x-content-type-options":"nosniff"}
  });
}
function ipv4(ip) {
  const x = ip.split(".");
  if (x.length !== 4 || x.some(s => !/^(0|[1-9][0-9]{0,2})$/.test(s) || Number(s)>255)) return null;
  return Uint8Array.from(x.map(Number));
}
function ipv6(ip) {
  if (ip.includes("%") || !/^[a-fA-F0-9:]+$/.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = s => s === "" ? [] : s.split(":");
  const left = parse(halves[0]), right = parse(halves[1] || "");
  const parts = [...left, ...right];
  if (parts.some(s=> !/^[0-9a-fA-F]{1,4}$/.test(s))) return null;
  if (halves.length === 1 && parts.length !== 8) return null;
  if (halves.length === 2 && parts.length >= 8) return null;
  const words = halves.length === 2 ? [...left, ...Array(8-parts.length).fill("0"), ...right] : parts;
  const bytes = new Uint8Array(16);
  words.forEach((s,i)=>{ const n=parseInt(s,16); bytes[2*i]=n>>8; bytes[2*i+1]=n&255; });
  return bytes;
}
export function parseIP(ip) {
  if (typeof ip !== "string" || ip.length > 45) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return parseIP(mapped[1]);
  const b = ip.includes(":") ? ipv6(ip) : ipv4(ip);
  return b ? {version:b.length===4?4:6, bytes:b} : null;
}
export function u32(a, offset) {
  return ((a[offset] | (a[offset+1]<<8) | (a[offset+2]<<16) | (a[offset+3]<<24))>>>0);
}
export function compare(ip, bytes, offset, v) {
  for(let i=0;i<ip.length;i++){
    const n = bytes[offset+(v===4 ? ip.length-1-i : i)];
    if(ip[i]!==n) return ip[i]<n?-1:1;
  }
  return 0;
}
async function rangeRead(env, key, offset, length) {
  const item = await env.IP_DB.get(key, {range:{offset,length}});
  if(!item) throw new Error("Missing XDB object");
  const bytes = new Uint8Array(await item.arrayBuffer());
  if(bytes.byteLength !== length) throw new Error("Incomplete XDB range");
  return bytes;
}
async function manifest(env) {
  if(activeCache && Date.now() < activeUntil) return activeCache;
  const obj = await env.IP_DB.get("manifest.json");
  if(!obj) return null;
  const value = await obj.json();
  if(!value.v4?.key || !value.v6?.key) throw new Error("Invalid manifest");
  activeCache = value;
  activeUntil = Date.now()+300000;
  return value;
}
async function vector(env, key) {
  if(!indexes.has(key)){
    const p = rangeRead(env,key,HEADER_SIZE,VECTOR_SIZE).catch(e=>{indexes.delete(key); throw e;});
    indexes.set(key,p);
    // Keep at most two active IPv4/IPv6 generations in each isolate.
    while (indexes.size > 4) indexes.delete(indexes.keys().next().value);
  }
  return indexes.get(key);
}
export async function lookup(env, version, ipBytes, selected) {
  const v = version === 4 ? selected.v4 : selected.v6;
  const key = v.key;
  const resultKey = key + ":" + ipBytes.join(".");
  const hit = cachedRegion(resultKey);
  if (hit !== null) return hit;

  const index = await vector(env, key);
  const prefix = ipBytes[0] * 256 + ipBytes[1];
  const position = prefix * 8;
  const start = u32(index, position), end = u32(index, position + 4);
  if (start === 0 || end === 0 || end < start) return "";
  const recordLength = version === 4 ? 14 : 38;
  if ((end - start) % recordLength !== 0) throw new Error("Invalid XDB segment alignment");
  const count = Math.floor((end - start) / recordLength) + 1;
  if (count < 1 || count > 50000000) throw new Error("Invalid XDB segment boundaries");
  const length = count * recordLength;
  let record;
  if (length <= SEGMENT_CACHE_BYTES) {
    const segmentKey = key + ":" + prefix;
    let promise = segments.get(segmentKey);
    if (!promise) {
      promise = rangeRead(env, key, start, length).catch(error => {
        segments.delete(segmentKey);
        throw error;
      });
    }
    remember(segments, segmentKey, promise, SEGMENT_CACHE_ENTRIES);
    record = findRecord(ipBytes, version, await promise, recordLength);
  } else {
    record = await locateInLargeSegment(env, key, ipBytes, version, start, count, recordLength);
  }
  if (!record) return "";

  const d = ipBytes.length * 2;
  const regionLength = record[d] | (record[d + 1] << 8);
  const regionOffset = u32(record, d + 2);
  if (!regionLength || regionLength > 16384 || regionOffset < HEADER_SIZE + VECTOR_SIZE) {
    throw new Error("Invalid region pointer");
  }
  const region = textDecoder.decode(await rangeRead(env, key, regionOffset, regionLength));
  remember(recentRegions, resultKey, region, RESULT_CACHE_ENTRIES);
  return region;
}
export async function checkFile(env,key,version,expectedSize){
  const head=await env.IP_DB.head(key);
  if(!head || head.size!==expectedSize || head.size<MIN[version]) throw new Error("XDB size validation failed");
  const header=await rangeRead(env,key,0,HEADER_SIZE);
  const structure=header[0]|(header[1]<<8);
  const ipVersion=header[16]|(header[17]<<8);
  if(!(structure===2 && version===4) && !(structure===3 && ipVersion===version)) {
    throw new Error("XDB format/version validation failed");
  }
  const first=await rangeRead(env,key,HEADER_SIZE,8);
  if(first.length!==8) throw new Error("XDB index validation failed");
}
async function download(env, sha, commitSha, version) {
  const name=DB[version];
  const key="versions/"+sha+"/"+name;
  const url=RAW+"/"+commitSha+"/data/"+name;
  // Pin the download to one upstream Git commit.
  const response=await fetch(url,{headers:{"user-agent":"qx-ip2region-worker"}});
  if(!response.ok || !response.body) throw new Error("Upstream XDB download failed: "+response.status);
  const size=Number(response.headers.get("content-length"));
  if(!Number.isInteger(size) || size<MIN[version] || size>100000000) throw new Error("Unexpected upstream XDB size");
  await env.IP_DB.put(key,response.body,{httpMetadata:{contentType:"application/octet-stream"}});
  await checkFile(env,key,version,size);
  return {key,sha,size};
}
async function fileMeta(name, commitSha) {
  const response=await fetch(UPSTREAM+"/"+name+"?ref="+commitSha,{headers:{"accept":"application/vnd.github+json","user-agent":"qx-ip2region-worker"}});
  if(!response.ok) throw new Error("GitHub metadata request failed: "+response.status);
  const data=await response.json();
  if(!/^[a-f0-9]{40}$/.test(data.sha||"") || data.size<500000 || data.size>100000000) throw new Error("Invalid upstream metadata");
  return {sha:data.sha,size:data.size};
}
export async function sync(env){
  const old=await manifest(env);
  const commitResp=await fetch(COMMIT_ENDPOINT,{headers:{"accept":"application/vnd.github+json","user-agent":"qx-ip2region-worker"}});
  if(!commitResp.ok) throw new Error("GitHub commit lookup failed: "+commitResp.status);
  const commitSha=(await commitResp.json()).sha;
  if(!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Invalid upstream commit");
  const next={updatedAt:new Date().toISOString(),source:"lionsoul2014/ip2region",commitSha,v4:old?.v4,v6:old?.v6};
  let changed=false;
  for(const version of [4,6]){
    const label=version===4?"v4":"v6";
    const meta=await fileMeta(DB[version],commitSha);
    if(old?.[label]?.sha===meta.sha) continue;
    const item=await download(env,meta.sha,commitSha,version);
    if(item.size!==meta.size) throw new Error("XDB metadata mismatch");
    // Check live lookup of representative public addresses before committing.
    const trial={v4:old?.v4,v6:old?.v6,[label]:item};
    const address=version===4?ipv4("1.2.3.4"):ipv6("2604:a840:3::a04d");
    const region=await lookup(env,version,address,trial);
    if(!region || region.split("|").length<5) throw new Error("XDB sample lookup failed");
    next[label]=item;
    changed=true;
  }
  if(!next.v4 || !next.v6) throw new Error("Incomplete XDB release");
  // Daily integrity probe runs even when upstream XDB hashes are unchanged.
  for (const version of [4, 6]) {
    const address = version===4 ? ipv4("1.2.3.4") : ipv6("2604:a840:3::a04d");
    const sample = await lookup(env, version, address, next);
    if (!sample || sample.split("|").length < 5) throw new Error("Daily XDB lookup health check failed");
  }
  if(changed){
    if(old) await env.IP_DB.put("history/"+Date.now()+".json",JSON.stringify(old));
    await env.IP_DB.put("manifest.json",JSON.stringify(next),{httpMetadata:{contentType:"application/json"}});
    activeCache=next;
    activeUntil=Date.now()+300000;
  }
  return {changed,updatedAt:next.updatedAt};
}

const CODE_REPOSITORY = "https://api.github.com/repos/harlanho4/qx-ip2region/commits/main";
const DEPLOY_HOOK_OBJECT = "internal/deploy-hook-uuid";
const DEPLOY_STATE_OBJECT = "internal/deploy-last.json";

// Failures preserve the previous SHA so that the next scheduled check can retry.
// The hook UUID is a bearer credential, stored exclusively in private R2.
export async function checkCode(env) {
  const [hookObject, stateObject] = await Promise.all([
    env.IP_DB.get(DEPLOY_HOOK_OBJECT),
    env.IP_DB.get(DEPLOY_STATE_OBJECT)
  ]);
  if (!hookObject) throw new Error("Missing private Cloudflare deploy hook");
  const id = (await hookObject.text()).trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Invalid deploy-hook identifier");

  const response = await fetch(CODE_REPOSITORY, {
    headers: {"Accept":"application/vnd.github+json","User-Agent":"qx-ip2region-scheduled-build"}
  });
  if (!response.ok) throw new Error("GitHub commit polling failed: "+response.status);
  const latest = (await response.json()).sha;
  if (!/^[0-9a-f]{40}$/i.test(latest)) throw new Error("Invalid upstream commit SHA");
  const previous = stateObject ? await stateObject.json() : null;
  if (previous?.sha === latest) return {changed:false,sha:latest};

  const trigger = await fetch(
    "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/"+id,
    {method:"POST"}
  );
  if (!trigger.ok) throw new Error("Cloudflare deploy hook failed: "+trigger.status);
  // The hook was accepted; any build errors remain visible in Workers Builds.
  await env.IP_DB.put(DEPLOY_STATE_OBJECT,JSON.stringify({
    sha:latest,triggeredAt:new Date().toISOString()
  }),{httpMetadata:{contentType:"application/json"}});
  return {changed:true,sha:latest};
}

const taskJs = "/*\n * Quantumult X · IP2Region HTTP Request\n * [task_local]\n * event-interaction https://qx-ip2region.harlanho4.workers.dev/task.js, tag=GeoIP 查询, img-url=location.fill.viewfinder.system, enabled=true\n *\n * Queries the currently selected node's public egress IP using the same\n * private R2-backed ip2region database as geo_location_checker.\n */\nvar geoNode = typeof $environment !== \"undefined\" && $environment &&\n              typeof $environment.params === \"string\"\n  ? $environment.params.trim() : \"\";\nvar geoStart = Date.now();\nvar geoRequest = {\n  url: \"https://qx-ip2region.harlanho4.workers.dev/geo\",\n  timeout: 6000\n};\nif (geoNode) geoRequest.opts = { policy: geoNode };\n\nfunction geoText(value) {\n  if (value === null || value === undefined) return \"\";\n  var text = String(value).trim();\n  return text === \"0\" || text === \"null\" || text === \"undefined\" ? \"\" : text.slice(0, 240);\n}\nfunction geoEscape(value) {\n  return geoText(value).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\")\n    .replace(/>/g, \"&gt;\").replace(/\"/g, \"&quot;\").replace(/'/g, \"&#39;\");\n}\nfunction geoFlag(value) {\n  var code = geoText(value).toUpperCase();\n  if (!/^[A-Z]{2}$/.test(code) || typeof String.fromCodePoint !== \"function\") return \"🌐\";\n  return String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);\n}\nfunction geoRow(label, value) {\n  return '<tr><td style=\"padding:10px 6px;color:#929292;white-space:nowrap;text-align:left;\">' +\n    geoEscape(label) + '</td><td style=\"padding:10px 6px;text-align:right;overflow-wrap:anywhere;\">' +\n    geoEscape(value || \"未知\") + '</td></tr>';\n}\nfunction geoPanel(body) {\n  var country = geoText(body.country) || \"未知地区\";\n  var province = geoText(body.regionName);\n  var city = geoText(body.city);\n  var isp = geoText(body.isp);\n  var ip = geoText(body.query);\n  if (!ip) throw new Error(\"缺少出口 IP\");\n\n  var places = [];\n  if (province && province !== country) places.push(province);\n  if (city && city !== province && city !== country) places.push(city);\n  var location = places.join(\" · \") || country;\n  var family = ip.indexOf(\":\") === -1 ? \"IPv4\" : \"IPv6\";\n  var flag = geoFlag(body.countryCode);\n  var ms = Math.max(0, Date.now() - geoStart);\n\n  var html = '<div style=\"font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;color:inherit;padding:5px 8px;\">' +\n    '<div style=\"font-size:29px;font-weight:650;text-align:center;margin:10px 0 2px;\">' +\n    flag + ' ' + geoEscape(country) + '</div>' +\n    '<div style=\"text-align:center;font-size:14px;color:#929292;margin:0 0 16px;\">' +\n    geoEscape(location) + '</div>' +\n    '<table style=\"width:100%;border-collapse:collapse;border-top:1px solid rgba(128,128,128,.28);\">' +\n    geoRow(\"出口 IP\", ip) +\n    geoRow(\"网络协议\", family) +\n    geoRow(\"国家/地区\", country) +\n    (province && province !== country ? geoRow(\"省份/州\", province) : \"\") +\n    (city && city !== province ? geoRow(\"城市\", city) : \"\") +\n    geoRow(\"运营商\", isp || \"未知\") +\n    (geoNode ? geoRow(\"查询节点\", geoNode) : \"\") +\n    '</table><div style=\"text-align:center;color:#929292;font-size:12px;margin:14px 0 4px;\">' +\n    'ip2region · ' + ms + ' ms</div></div>';\n\n  $done({ title: \"GeoIP · \" + flag + \" \" + country, htmlMessage: html });\n}\nfunction geoFail(reason) {\n  var detail = geoEscape(reason);\n  var html = '<div style=\"font-family:-apple-system,sans-serif;text-align:center;padding:18px;\">' +\n    '<div style=\"font-size:28px;margin-bottom:12px;\">⚠️</div>' +\n    '<div style=\"font-weight:600;\">归属地查询失败</div>' +\n    '<div style=\"color:#929292;font-size:14px;margin-top:8px;\">' + detail + '</div>' +\n    (geoNode ? '<div style=\"color:#929292;margin-top:12px;font-size:13px;\">节点：' + geoEscape(geoNode) + '</div>' : \"\") +\n    '</div>';\n  $done({ title: \"GeoIP · 查询失败\", htmlMessage: html });\n}\ntry {\n  $task.fetch(geoRequest).then(function (response) {\n    try {\n      var status = Number(response && (response.statusCode || response.status));\n      if (status !== 200) throw new Error(\"HTTP \" + (status || \"未知\"));\n      var data = JSON.parse(response.body || \"{}\");\n      if (data.status && data.status !== \"success\") throw new Error(\"GeoIP 数据暂不可用\");\n      geoPanel(data);\n    } catch (error) {\n      geoFail(error.message || \"解析失败\");\n    }\n  }, function (error) {\n    geoFail(error && error.message ? error.message : \"网络连接超时\");\n  });\n} catch (error) {\n  geoFail(error && error.message ? error.message : \"查询启动失败\");\n}";
const QX_SCRIPT_VERSION = "classic";
const qxJs = "// Quantumult X geo_location_checker · ip2region\n// Original compact presentation: country / location and ISP / details.\nvar info = {};\nvar status = (typeof $response === \"undefined\") ? 0 : Number($response.statusCode);\ntry {\n  info = JSON.parse($response.body || \"{}\") || {};\n} catch (e) {\n  info = {};\n}\nfunction field(value) {\n  return typeof value === \"string\" && value !== \"0\" ? value.trim() : \"\";\n}\nvar country = field(info.country) || \"未知\";\nvar province = field(info.regionName);\nvar city = field(info.city);\nvar isp = field(info.isp);\nvar ip = field(info.query);\nvar countryCode = field(info.countryCode).toUpperCase();\nvar flag = \"\";\nif (/^[A-Z]{2}$/.test(countryCode) && typeof String.fromCodePoint === \"function\") {\n  flag = String.fromCodePoint(countryCode.charCodeAt(0) + 127397,\n                              countryCode.charCodeAt(1) + 127397);\n}\nvar location = [];\nif (province) location.push(province);\nif (city && city !== province) location.push(city);\nif (isp) location.push(isp);\nvar subtitle = location.join(\" · \") || \"归属地信息暂缺\";\nif (status === 200 && ip) {\n  $done({\n    title: (flag ? flag + \" \" : \"\") + country,\n    subtitle: subtitle,\n    ip: ip,\n    description: \"国家：\" + country +\n      \"\\n省份：\" + (province || \"未知\") +\n      \"\\n城市：\" + (city || \"未知\") +\n      \"\\n运营商：\" + (isp || \"未知\") +\n      \"\\n数据源：ip2region\"\n  });\n} else {\n  $done({\n    title: \"GeoIP 查询失败\",\n    subtitle: \"HTTP \" + (status || \"未知\"),\n    ip: \"\",\n    description: \"请检查网络连接或稍后重试\"\n  });\n}";
export default {
  async fetch(request,env,ctx) {
    const u=new URL(request.url);
    // Canonical display script; historical versioned URLs remain aliases.
    if(["/qx.js","/qx-v2.js","/qx-safe.js","/qx-v22.js","/qx-lite.js"].includes(u.pathname)) {
      return new Response(qxJs, {headers:{
        "content-type":"application/javascript; charset=utf-8",
        "cache-control":"no-store, max-age=0",
        "x-content-type-options":"nosniff",
        "x-qx-script-version":QX_SCRIPT_VERSION
      }});
    }
    if(u.pathname==="/task.js") {
      return new Response(taskJs, {headers:{
        "content-type":"application/javascript; charset=utf-8",
        "cache-control":"no-store, max-age=0",
        "x-content-type-options":"nosniff"
      }});
    }
    if(u.pathname==="/health"){
      const m=await manifest(env);
      return json({ok:!!m,initialized:!!m,updatedAt:m?.updatedAt||null,scriptVersion:QX_SCRIPT_VERSION,versions:m?{v4:m.v4.sha,v6:m.v6.sha}:null},m?200:503);
    }
    if(u.pathname!=="/geo") return json({error:"Not found"},404);
    if(request.method!=="GET") return json({error:"Method not allowed"},405);
    // Protect R2 Class B operations against automated traffic.
    // The limiter is per egress IP and per Cloudflare location, not a global quota.
    if (!env.GEO_RATE_LIMIT) return json({error:"Rate limiter unavailable"},503);
    const rateKey=request.headers.get("CF-Connecting-IP") || "unknown";
    const decision=await env.GEO_RATE_LIMIT.limit({key:rateKey});
    if(!decision.success) return json({error:"Too many requests"},429);
    let ip=request.headers.get("CF-Connecting-IP")||"";
    if(blocked.has(ip)) return json({error:"Invalid address"},400);
    const parsed=parseIP(ip);
    if(!parsed) return json({error:"Invalid client address"},400);
    try{
      const m=await manifest(env);
      if(!m) return json({error:"Database initializing"},503);
      const region=await lookup(env,parsed.version,parsed.bytes,m);
      if(!region) return json({error:"Region unavailable",query:ip},404);
      const [country,province,city,isp,code]=region.split("|").map(s=>s==="0"?"":s);
      return json({status:"success",query:ip,country:country||"",regionName:province||"",city:city||"",isp:isp||"",org:"",countryCode:code||""});
    }catch(e){
      console.error("GeoIP query failed:",String(e));
      return json({error:"GeoIP lookup failed"},503);
    }
  },
  async scheduled(event,env,ctx) {
    if(event.cron==="0 3 * * *") {
      ctx.waitUntil(sync(env).then(r=>console.log("ip2region update",JSON.stringify(r))).catch(e=>console.error("ip2region update failed",String(e))));
    } else if(event.cron==="*/10 * * * *") {
      ctx.waitUntil(checkCode(env).then(r=>console.log("source build check",r.changed)).catch(e=>console.error("source build check failed",String(e))));
    }
  }
};