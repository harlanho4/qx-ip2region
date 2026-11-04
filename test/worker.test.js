import test from "node:test";
import assert from "node:assert/strict";
import worker, {parseIP, u32, compare} from "../src/index.js";

test("IPv4 and IPv6 addresses parse correctly", () => {
  assert.deepEqual(Array.from(parseIP("1.2.3.4").bytes), [1,2,3,4]);
  assert.equal(parseIP("1.2.3.4").version, 4);
  assert.equal(parseIP("2001:db8::1").version, 6);
  assert.equal(parseIP("::ffff:1.2.3.4").version, 4);
  assert.equal(parseIP("2001:db8:0:0:0:0:0:1").bytes.length, 16);
  assert.equal(parseIP("::1").bytes.length, 16);
});
test("reject malformed or ambiguous addresses", () => {
  for (const ip of ["", "999.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "gg::1", "1:::2", "1:2:3:4:5:6:7:8:9", "2001:db8::1::2", "::ffff:999.1.1.1"]) {
    assert.equal(parseIP(ip), null, ip);
  }
});
test("XDB little-endian pointer and IPv4/IPv6 comparisons", () => {
  assert.equal(u32(Uint8Array.from([0x78,0x56,0x34,0x12]), 0), 0x12345678);
  assert.equal(compare(Uint8Array.from([1,2,3,4]), Uint8Array.from([4,3,2,1]), 0, 4), 0);
  assert.equal(compare(Uint8Array.from([1,2,3,5]), Uint8Array.from([4,3,2,1]), 0, 4), 1);
  assert.equal(compare(Uint8Array.from([0,1]), Uint8Array.from([0,1]), 0, 6), 0);
});
test("response handling, health and Quantumult X script", async () => {
  const kv = {async get() { return null; }};
  const env = {IP_DB: kv};
  const context = {waitUntil() {}};
  const script = await worker.fetch(new Request("https://example.com/qx.js"), env, context);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /\$done/);
  const unknown = await worker.fetch(new Request("https://example.com/unknown"), env, context);
  assert.equal(unknown.status, 404);
  const health = await worker.fetch(new Request("https://example.com/health"), env, context);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).initialized, false);
});

test("GeoIP fails closed when rate-limit binding is unavailable", async () => {
  const env = {IP_DB: {async get(){throw Error("R2 access is unexpected");}}};
  const request = new Request("https://example.com/geo", {
    headers: {"CF-Connecting-IP":"1.2.3.4"}
  });
  const response = await worker.fetch(request,env,{waitUntil(){}});
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,"Rate limiter unavailable");
});

test("GeoIP returns 429 before accessing R2 if rate limit exceeded", async () => {
  let rateKey = "";
  const env = {
    IP_DB: {async get(){throw Error("R2 access is unexpected");}},
    GEO_RATE_LIMIT: {async limit({key}){rateKey=key;return {success:false};}}
  };
  const request = new Request("https://example.com/geo", {
    headers: {"CF-Connecting-IP":"1.2.3.4"}
  });
  const response = await worker.fetch(request,env,{waitUntil(){}});
  assert.equal(response.status,429);
  assert.equal((await response.json()).error,"Too many requests");
  assert.equal(rateKey,"1.2.3.4");
});

function makeXdbFixture(version, address, region) {
  const ip=parseIP(address).bytes;
  const indexBase=256, indexLength=524288, recordSize=version===4?14:38;
  const recordOffset=indexBase+indexLength;
  const regionBytes=new TextEncoder().encode(region);
  const regionOffset=recordOffset+recordSize;
  const content=new Uint8Array(regionOffset+regionBytes.length);
  const dataView=new DataView(content.buffer);
  dataView.setUint16(0,3,true);
  dataView.setUint16(16,version,true);
  dataView.setUint16(18,4,true);
  const vectorEntry=indexBase+(ip[0]*256+ip[1])*8;
  dataView.setUint32(vectorEntry,recordOffset,true);
  dataView.setUint32(vectorEntry+4,recordOffset,true);
  for(let segment=0;segment<2;segment++){
    const start=recordOffset+segment*ip.length;
    for(let j=0;j<ip.length;j++) content[start+j]=version===4?ip[ip.length-j-1]:ip[j];
  }
  dataView.setUint16(recordOffset+ip.length*2,regionBytes.length,true);
  dataView.setUint32(recordOffset+ip.length*2+2,regionOffset,true);
  content.set(regionBytes,regionOffset);
  const key="test-"+version+"-"+address+".xdb";
  const bucket={
    async get(requestKey, options){
      assert.equal(requestKey,key);
      const range=options.range;
      const slice=content.slice(range.offset,range.offset+range.length);
      return {async arrayBuffer(){return slice.buffer;}};
    },
    async head(requestKey){
      assert.equal(requestKey,key);
      return {size:content.length};
    }
  };
  return {key,bucket,size:content.length,region,bytes:ip};
}
test("look up actual IPv4 and IPv6 XDB records using R2 byte ranges", async()=>{
  const {lookup,checkFile}=await import("../src/index.js");
  for (const {version,address,region} of [
    {version:4,address:"1.2.3.4",region:"Australia|Queensland|Brisbane|0|AU"},
    {version:6,address:"2604:a840:3::a04d",region:"United States|California|San Jose|xTom|US"}
  ]){
    const fixture=makeXdbFixture(version,address,region);
    const env={IP_DB:fixture.bucket};
    const active=version===4?{v4:{key:fixture.key}}:{v6:{key:fixture.key}};
    await checkFile(env,fixture.key,version,fixture.size);
    assert.equal(await lookup(env,version,fixture.bytes,active),fixture.region);
  }
});

test("scheduled private deploy hook fires once per changed GitHub SHA", async () => {
  const {checkCode} = await import("../src/index.js");
  const id="00000000-0000-4000-8000-000000000001";
  const sha="a".repeat(40);
  const stored=new Map([["internal/deploy-hook-uuid",id]]);
  const env={IP_DB:{
    async get(key) {
      const raw=stored.get(key);
      return raw==null?null:{async text(){return raw;},async json(){return JSON.parse(raw);}};
    },
    async put(key,value){stored.set(key,value);}
  }};
  const originalFetch=globalThis.fetch;
  let postCount=0;
  try{
    globalThis.fetch=async (url,opts={})=>{
      if(String(url).includes("github.com"))return new Response(JSON.stringify({sha}),{status:200});
      assert.match(String(url),/workers\/builds\/deploy_hooks/);
      assert.equal(opts.method,"POST");
      postCount++;
      return new Response(JSON.stringify({success:true}),{status:200});
    };
    assert.equal((await checkCode(env)).changed,true);
    assert.equal((await checkCode(env)).changed,false);
    assert.equal(postCount,1);
    assert.equal(JSON.parse(stored.get("internal/deploy-last.json")).sha,sha);
  } finally {globalThis.fetch=originalFetch;}
});

test("failed deployment hook is retried on the next check", async()=>{
  const {checkCode}=await import("../src/index.js");
  const sha="b".repeat(40);
  const id="00000000-0000-4000-8000-000000000002";
  const state=new Map([["internal/deploy-hook-uuid",id]]);
  const env={IP_DB:{
    async get(key){const v=state.get(key);return v==null?null:{async text(){return v;},async json(){return JSON.parse(v);}};},
    async put(key,v){state.set(key,v);}
  }};
  const originalFetch=globalThis.fetch;
  try{
    globalThis.fetch=async url=>{
      if(String(url).includes("github.com"))return new Response(JSON.stringify({sha}),{status:200});
      return new Response("failed",{status:503});
    };
    await assert.rejects(checkCode(env),/deploy hook failed/);
    assert.equal(state.has("internal/deploy-last.json"),false);
  }finally{globalThis.fetch=originalFetch;}
});


test("Quantumult X renders elegant country, city, ISP and node tag", async () => {
  const {runInNewContext} = await import("node:vm");
  const response = await worker.fetch(
    new Request("https://example.com/qx.js"),
    {IP_DB:{}}, {waitUntil(){}}
  );
  const script = await response.text();
  let output;
  runInNewContext(script, {
    $response: {
      statusCode: 200,
      body: JSON.stringify({
        status:"success", country:"日本", regionName:"东京都",
        city:"东京", isp:"NTT Communications", query:"1.2.3.4",
        countryCode:"JP"
      })
    },
    $environment: {params:"日本 · Tokyo"},
    $done(value){output=value;}
  });
  assert.equal(output.title,"🇯🇵 日本 · 东京");
  assert.match(output.subtitle,/v2\.2/);
  assert.match(output.subtitle,/NTT Communications/);
  assert.equal(output.ip,"1.2.3.4");
  assert.match(output.description,/日本 › 东京都 › 东京/);
  assert.match(output.description,/数据源：ip2region/);
  assert.ok(output.description.includes("\n"));
  assert.ok(!output.description.includes("\\n"));
});

test("Quantumult X handles IPv6, repeated locations and missing ISP", async () => {
  const {runInNewContext} = await import("node:vm");
  const script = await (await worker.fetch(
    new Request("https://example.com/qx.js"), {IP_DB:{}}, {waitUntil(){}}
  )).text();
  let output;
  runInNewContext(script, {
    $response: {statusCode:200,body:JSON.stringify({
      status:"success",country:"中国",regionName:"上海",city:"上海",
      isp:"0",query:"2001:db8::1",countryCode:"CN"
    })},
    $done(value){output=value;}
  });
  assert.equal(output.title,"🇨🇳 中国 · 上海");
  assert.equal(output.ip,"2001:db8::1");
  assert.match(output.subtitle,/IPv6/);
  assert.match(output.description,/运营商未知/);
  assert.ok(!output.description.includes("上海  ›  上海"));
});

test("Quantumult X returns graceful errors for bad HTTP, JSON or absent IP", async () => {
  const {runInNewContext} = await import("node:vm");
  const script = await (await worker.fetch(
    new Request("https://example.com/qx.js"), {IP_DB:{}}, {waitUntil(){}}
  )).text();
  const cases = [
    {statusCode:429,body:JSON.stringify({error:"Too many requests"})},
    {statusCode:200,body:"not JSON"},
    {statusCode:200,body:JSON.stringify({status:"success",country:"日本"})},
    {statusCode:200,body:JSON.stringify({status:"error"})}
  ];
  for (const response of cases) {
    let output;
    runInNewContext(script, {
      $response:response,
      $done(value){output=value;}
    });
    assert.match(output.title,/GeoIP 查询异常/);
    assert.equal(output.ip,"");
  }
});


test("versioned Quantumult X endpoint bypasses caches and serves identical script", async()=>{
  const env={IP_DB:{async get(){return null;}}};
  const ctx={waitUntil(){}};
  const old=await worker.fetch(new Request("https://example.com/qx.js"),env,ctx);
  const fresh=await worker.fetch(new Request("https://example.com/qx-v2.js"),env,ctx);
  assert.equal(old.status,200);
  assert.equal(fresh.status,200);
  assert.equal(old.headers.get("cache-control"),"no-store, max-age=0");
  assert.equal(fresh.headers.get("cache-control"),"no-store, max-age=0");
  assert.equal(fresh.headers.get("x-qx-script-version"),"2.2");
  const a=await old.text(),b=await fresh.text();
  assert.equal(a,b);
  assert.match(b,/Quantumult X geo_location_checker/);
  assert.match(b,/v2\.2/);
  const health=await worker.fetch(new Request("https://example.com/health"),env,ctx);
  assert.equal((await health.json()).scriptVersion,"2.2");
});


test("safe versioned QX script always emits a render even if HTTP status or data is invalid", async () => {
  const {runInNewContext} = await import("node:vm");
  const response=await worker.fetch(new Request("https://example.com/qx-safe.js"),{IP_DB:{}},{waitUntil(){}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("x-qx-script-version"),"2.2");
  const js=await response.text();
  assert.ok(!js.includes("(function ()"));
  for(const payload of [
    {statusCode:200,body:JSON.stringify({status:"success",country:"Taiwan",regionName:"Taiwan",city:"Taipei",isp:"CHUNGHWA TELECOM CO., LTD.",query:"203.0.113.18",countryCode:"TW"})},
    {statusCode:200,body:JSON.stringify({status:"success",country:"日本",regionName:"东京都",city:"东京",isp:"NTT",query:"2001:db8::1",countryCode:"JP"})},
    {statusCode:503,body:'{"error":"temporarily unavailable"}'},
    {statusCode:200,body:"garbled"}
  ]){
    let result;
    runInNewContext(js,{$response:payload,$done(x){result=x;}});
    assert.ok(result,"$done must always be called");
    assert.ok(result.title);
    assert.ok(result.subtitle);
    assert.ok(result.description);
    if(payload.statusCode!==200||payload.body==="garbled")assert.match(result.title,/GeoIP 查询异常/);
  }
});

test("separate QX diagnostic route produces a visibly different UI without relying on JSON success", async () => {
  const {runInNewContext} = await import("node:vm");
  const res = await worker.fetch(new Request("https://example.com/qx-check.js"), {IP_DB:{}}, {waitUntil(){}});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(res.headers.get("x-qx-script-version"), "3.0");
  const script = await res.text();
  let output;
  runInNewContext(script, {
    $response: {
      statusCode: 200,
      body: JSON.stringify({query:"1.2.3.4",country:"日本"})
    },
    $done(value){output=value;}
  });
  assert.match(output.title,/自定义 GeoIP 脚本已生效/);
  assert.match(output.subtitle,/QX CHECK · v3\.0/);
  assert.equal(output.ip,"1.2.3.4");
  assert.match(output.description,/诊断脚本加载成功/);
  assert.ok(output.description.includes("\n"));
});


test("batch indexed lookup uses at most three R2 reads on cold prefix and zero on warm repeat", async () => {
  const {lookup} = await import("../src/index.js");
  const address = "93.184.216.34";
  const fixture = makeXdbFixture(4,address,"United States|California|Los Angeles|Example ISP|US");
  let reads=0;
  const originalGet = fixture.bucket.get;
  fixture.bucket.get = async (...args) => {
    reads++;
    return originalGet(...args);
  };
  const env={IP_DB:fixture.bucket};
  const manifest={v4:{key:fixture.key}};
  assert.equal(await lookup(env,4,fixture.bytes,manifest),fixture.region);
  assert.equal(reads,3,"vector, index batch and region each require one range read");
  assert.equal(await lookup(env,4,fixture.bytes,manifest),fixture.region);
  assert.equal(reads,3,"repeat lookups must be served from isolate cache");
});

test("large IPv4 prefix uses bounded slab search instead of record-by-record R2 requests", async () => {
  const {lookup} = await import("../src/index.js");
  const count=9600,recordSize=14,indexBase=256,indexLength=524288;
  const first=indexBase+indexLength;
  const region=new TextEncoder().encode("Example|Region|City|Network|US");
  const bytes=new Uint8Array(first+count*recordSize+region.length);
  const view=new DataView(bytes.buffer);
  view.setUint16(0,3,true);
  view.setUint16(16,4,true);
  view.setUint16(18,4,true);
  const prefix=(88*256+77)*8+indexBase;
  view.setUint32(prefix,first,true);
  view.setUint32(prefix+4,first+(count-1)*recordSize,true);
  for (let i=0;i<count;i++) {
    const pos=first+i*recordSize;
    const b2=Math.floor(i/256),b3=i%256;
    bytes.set([b3,b2,77,88,b3,b2,77,88],pos);
    view.setUint16(pos+8,region.length,true);
    view.setUint32(pos+10,first+count*recordSize,true);
  }
  bytes.set(region,first+count*recordSize);
  let reads=0;
  const key="large-segment-88-77-perf.xdb";
  const env={IP_DB:{
    async get(k,options) {
      assert.equal(k,key);
      reads++;
      const slice=bytes.slice(options.range.offset,options.range.offset+options.range.length);
      return {async arrayBuffer(){return slice.buffer;}};
    }
  }};
  const query=parseIP("88.77.20.9").bytes;
  assert.equal(await lookup(env,4,query,{v4:{key}}),"Example|Region|City|Network|US");
  assert.ok(reads<=6,"large segment should need only a few slab reads; observed "+reads);
  assert.equal(await lookup(env,4,query,{v4:{key}}),"Example|Region|City|Network|US");
  assert.ok(reads<=6,"repeat queries should reuse region cache");
});
