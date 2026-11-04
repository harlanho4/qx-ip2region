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
  }
  return indexes.get(key);
}
export async function lookup(env, version, ipBytes, selected) {
  const v = version === 4 ? selected.v4 : selected.v6;
  const key = v.key;
  const index = await vector(env,key);
  const position = (ipBytes[0]*256 + ipBytes[1])*8;
  const start = u32(index,position), end = u32(index,position+4);
  if(start===0 || end===0 || end<start) return "";
  const recordLength = version===4?14:38;
  const count = Math.floor((end-start)/recordLength)+1;
  if(count<1 || count>50000000) throw new Error("Invalid XDB segment boundaries");
  let low=0, high=count-1;
  while(low<=high){
    const mid = (low+high)>>>1;
    const record = await rangeRead(env,key,start+mid*recordLength,recordLength);
    const a = compare(ipBytes,record,0,version);
    const b = compare(ipBytes,record,ipBytes.length,version);
    if(a<0) high=mid-1;
    else if(b>0) low=mid+1;
    else{
      const d=ipBytes.length*2;
      const len=record[d]|(record[d+1]<<8), offset=u32(record,d+2);
      if(!len || len>16384 || offset<HEADER_SIZE+VECTOR_SIZE) throw new Error("Invalid region pointer");
      return textDecoder.decode(await rangeRead(env,key,offset,len));
    }
  }
  return "";
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
async function fileMeta(name) {
  const response=await fetch(UPSTREAM+"/"+name,{headers:{"accept":"application/vnd.github+json","user-agent":"qx-ip2region-worker"}});
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
    const meta=await fileMeta(DB[version]);
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
  if(changed){
    if(old) await env.IP_DB.put("history/"+Date.now()+".json",JSON.stringify(old));
    await env.IP_DB.put("manifest.json",JSON.stringify(next),{httpMetadata:{contentType:"application/json"}});
    activeCache=next;
    activeUntil=Date.now()+300000;
  }
  return {changed,updatedAt:next.updatedAt};
}
const qxJs = 'if($response.statusCode!==200){$done({title:"GeoIP 查询失败",subtitle:"请检查 Worker 数据库",ip:"",description:"HTTP "+$response.statusCode});}else{try{var r=JSON.parse($response.body);var a=(r.countryCode||"").toUpperCase();var flag=/^[A-Z]{2}$/.test(a)?Array.from(a).map(function(c){return String.fromCodePoint(c.charCodeAt(0)+127397)}).join(""):"";$done({title:(flag?flag+" ":"")+(r.country||"未知"),subtitle:[r.regionName,r.city,r.isp].filter(Boolean).join(" · "),ip:r.query||"",description:["国家："+(r.country||"未知"),"省份："+(r.regionName||"未知"),"城市："+(r.city||"未知"),"运营商："+(r.isp||"未知"),"数据源：ip2region"].join("\\n")});}catch(e){$done({title:"GeoIP 解析错误",subtitle:String(e),ip:"",description:"Invalid JSON response"});}}';
export default {
  async fetch(request,env,ctx) {
    const u=new URL(request.url);
    if(u.pathname==="/qx.js") return new Response(qxJs,{headers:{"content-type":"application/javascript; charset=utf-8","cache-control":"public,max-age=3600","x-content-type-options":"nosniff"}});
    if(u.pathname==="/health"){
      const m=await manifest(env);
      return json({ok:!!m,initialized:!!m,updatedAt:m?.updatedAt||null,versions:m?{v4:m.v4.sha,v6:m.v6.sha}:null},m?200:503);
    }
    if(u.pathname!=="/geo") return json({error:"Not found"},404);
    if(request.method!=="GET") return json({error:"Method not allowed"},405);
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
    ctx.waitUntil(sync(env).then(r=>console.log("ip2region update",JSON.stringify(r))).catch(e=>console.error("ip2region update failed",String(e))));
  }
};