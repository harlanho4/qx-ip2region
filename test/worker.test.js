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
