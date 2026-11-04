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
