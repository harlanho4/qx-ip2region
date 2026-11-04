import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import worker, {isPublicIPv4,parseIP} from "../src/index.js";

const source=readFileSync(new URL("../scripts/geo_location.js", import.meta.url),"utf8");

function executeTask(probe,lookup,options={}) {
  const calls=[];
  let complete;
  const finished=new Promise(resolve=>{complete=resolve;});
  const context={
    $environment:{params:options.policy===undefined?"日本 · A":options.policy},
    $task:{fetch(request){
      calls.push(request);
      const response=calls.length===1?probe:lookup;
      if(response instanceof Error)return Promise.reject(response);
      return Promise.resolve({
        statusCode:response?.statusCode??200,
        body:typeof response?.body==="string"?response.body:JSON.stringify(response?.body??{})
      });
    }},
    $done(value){complete(value);}
  };
  runInNewContext(source,context);
  return finished.then(result=>({result,calls}));
}

const ipv4Probe={body:{ip:"8.8.8.8"}};
const ipv4Region={body:{
  status:"success",query:"8.8.8.8",country:"美国",countryCode:"US",
  regionName:"加利福尼亚",city:"山景城",isp:"Google"
}};

test("interaction task is served verbatim by the Worker",async()=>{
  const response=await worker.fetch(new Request("https://example.com/task.js"),{IP_DB:{}},{waitUntil(){}});
  assert.equal(response.status,200);
  assert.match(response.headers.get("content-type"),/javascript/);
  assert.equal(response.headers.get("cache-control"),"no-store, max-age=0");
  assert.equal(await response.text(),source);
});

test("selected node discovers IPv4 first and looks up that exact IPv4 through XDB",async()=>{
  const {calls,result}=await executeTask(ipv4Probe,ipv4Region,{policy:"美国|节点A"});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,"https://api.ipify.org?format=json");
  assert.equal(calls[0].opts.policy,"美国|节点A");
  assert.equal(calls[1].url,"https://qx-ip2region.harlanho4.workers.dev/lookup4?ip=8.8.8.8");
  assert.equal(calls[1].opts.policy,"美国|节点A");
  assert.match(result.title,/🇺🇸 美国/);
  assert.match(result.htmlMessage,/8\.8\.8\.8/);
  assert.match(result.htmlMessage,/IPv4/);
  assert.match(result.htmlMessage,/加利福尼亚/);
  assert.match(result.htmlMessage,/山景城/);
  assert.match(result.htmlMessage,/Google/);
  assert.match(result.htmlMessage,/美国\|节点A/);
  assert.doesNotMatch(result.htmlMessage,/IPv6/);
});

test("IPv6 response never falls back to an IPv6 XDB lookup",async()=>{
  const {calls,result}=await executeTask({body:{ip:"2001:db8::1"}},ipv4Region);
  assert.equal(calls.length,1);
  assert.match(result.title,/查询失败/);
  assert.match(result.htmlMessage,/没有返回有效的 IPv4/);
});

test("invalid IPv4, network failures and lookup failures produce an error panel",async()=>{
  const tests=[
    [{body:{ip:"999.0.0.1"}},ipv4Region,/有效的 IPv4/],
    [{body:{ip:"1.2.3"}},ipv4Region,/有效的 IPv4/],
    [{statusCode:503,body:{}},ipv4Region,/IPv4 检测 HTTP 503/],
    [new Error("probe timeout"),ipv4Region,/probe timeout/],
    [ipv4Probe,{statusCode:429,body:{error:"rate-limited"}},/ip2region HTTP 429/],
    [ipv4Probe,new Error("lookup timeout"),/lookup timeout/],
    [ipv4Probe,{body:{...ipv4Region.body,query:"1.1.1.1"}},/IPv4 结果不匹配/],
    [ipv4Probe,{body:"{invalid JSON"},/JSON/]
  ];
  for(const [probe,geo,error] of tests){
    const {result}=await executeTask(probe,geo);
    assert.match(result.title,/查询失败/);
    assert.match(result.htmlMessage,error);
  }
});

test("interaction escapes HTML in user-controlled node name and removes duplicate city",async()=>{
  const {result}=await executeTask(ipv4Probe,{body:{
    ...ipv4Region.body, country:"中国",countryCode:"CN",regionName:"上海",city:"上海",isp:"0"
  }},{policy:"<img src=x onerror=alert(1)>"});
  assert.match(result.htmlMessage,/&lt;img/);
  assert.doesNotMatch(result.htmlMessage,/<img/);
  assert.match(result.htmlMessage,/运营商/);
  assert.match(result.htmlMessage,/IPv4/);
  assert.doesNotMatch(result.htmlMessage,/城市<\/td>/);
});

test("public IPv4 validation blocks private and reserved ranges",()=>{
  for(const address of ["0.0.0.0","10.0.0.1","172.16.1.1","192.168.1.1",
    "127.0.0.1","169.254.1.1","100.64.0.1","192.0.2.1","198.18.0.1",
    "198.51.100.1","203.0.113.1","255.255.255.255"]){
      assert.equal(isPublicIPv4(parseIP(address).bytes),false,address);
  }
  for(const address of ["8.8.8.8","1.1.1.1","9.9.9.9"]){
    assert.equal(isPublicIPv4(parseIP(address).bytes),true,address);
  }
});

test("lookup4 validates input and honors rate limits ahead of R2 reads",async()=>{
  const base="https://example.com/lookup4?ip=";
  const env={IP_DB:{async get(){throw new Error("Unexpected R2 read")}},
    GEO_RATE_LIMIT:{async limit(){return {success:true}}}};
  const ctx={waitUntil(){}};
  for(const ip of ["2001:db8::1","192.168.1.1","203.0.113.1","8.8.8.999",""]){
    const r=await worker.fetch(new Request(base+encodeURIComponent(ip),{
      headers:{"CF-Connecting-IP":"2606:4700:4700::1111"}}),env,ctx);
    assert.equal(r.status,400,ip);
    assert.equal((await r.json()).error,"A public IPv4 address is required");
  }
  const limited={...env,GEO_RATE_LIMIT:{async limit(){return {success:false}}}};
  const response=await worker.fetch(new Request(base+"8.8.8.8"),limited,ctx);
  assert.equal(response.status,429);
});

test("lookup4 uses chosen IPv4 even when Cloudflare observes an IPv6 client",async()=>{
  const ip="8.8.8.8";
  const regionText="United States|California|Mountain View|Google|US";
  const textBytes=new TextEncoder().encode(regionText);
  const vectorOffset=256, vectorSize=524288, recordOffset=vectorOffset+vectorSize;
  const recordSize=14, textOffset=recordOffset+recordSize;
  const bytes=new Uint8Array(textOffset+textBytes.length);
  const view=new DataView(bytes.buffer);
  const pointer=vectorOffset+(8*256+8)*8;
  view.setUint32(pointer,recordOffset,true);
  view.setUint32(pointer+4,recordOffset,true);
  bytes.set([8,8,8,8,8,8,8,8],recordOffset);
  view.setUint16(recordOffset+8,textBytes.length,true);
  view.setUint32(recordOffset+10,textOffset,true);
  bytes.set(textBytes,textOffset);
  const key="lookup4-integration-fixture.xdb";
  const env={
    GEO_RATE_LIMIT:{async limit(){return {success:true}}},
    IP_DB:{async get(requestKey, options){
      if(requestKey==="manifest.json")return {async json(){
        return {v4:{key},v6:{key:"unused"}};}};
      assert.equal(requestKey,key);
      const range=options.range;
      const slice=bytes.slice(range.offset,range.offset+range.length);
      return {async arrayBuffer(){return slice.buffer;}};
    }}
  };
  const response=await worker.fetch(
    new Request("https://example.com/lookup4?ip="+ip,{
      headers:{"CF-Connecting-IP":"2606:4700:4700::1111"}}),
    env,{waitUntil(){}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.query,ip);
  assert.equal(body.country,"United States");
  assert.equal(body.isp,"Google");
});
