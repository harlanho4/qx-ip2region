import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import worker from "../src/index.js";

const source = readFileSync(new URL("../scripts/geo_location.js", import.meta.url), "utf8");

function executeTask(body, options = {}) {
  const calls = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const context = {
    $environment: {params: options.policy || "测试节点 · 🇯🇵"},
    $task: {
      fetch(request) {
        calls.push(request);
        if (options.reject) return Promise.reject(new Error(options.reject));
        return Promise.resolve({
          statusCode: options.statusCode || 200,
          body: typeof body === "string" ? body : JSON.stringify(body)
        });
      }
    },
    $done(value) { resolveDone(value); }
  };
  runInNewContext(source, context);
  return done.then(value => ({value,calls}));
}

test("task script is served over HTTPS from the same Worker", async () => {
  const result = await worker.fetch(new Request("https://example.com/task.js"), {IP_DB:{}}, {waitUntil(){}});
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type"), /javascript/);
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.equal(await result.text(), source);
});

test("event-interaction uses selected Quantumult X node and sends one HTTPS request", async () => {
  const {value,calls} = await executeTask({
    status:"success", query:"203.0.113.1", country:"日本", countryCode:"JP",
    regionName:"东京都", city:"东京", isp:"NTT Communications"
  }, {policy:"日本丨节点A"});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qx-ip2region.harlanho4.workers.dev/geo");
  assert.equal(calls[0].opts.policy, "日本丨节点A");
  assert.equal(calls[0].timeout, 6000);
  assert.match(value.title, /GeoIP · 🇯🇵 日本/);
  assert.match(value.htmlMessage, /203\.0\.113\.1/);
  assert.match(value.htmlMessage, /东京都/);
  assert.match(value.htmlMessage, /东京/);
  assert.match(value.htmlMessage, /NTT Communications/);
  assert.match(value.htmlMessage, /日本丨节点A/);
  assert.match(value.htmlMessage, /ip2region/);
});

test("task handles IPv6, unknown ISP, duplicate city and escapes user-controlled HTML", async () => {
  const {value} = await executeTask({
    query:"2001:db8::1", country:"中国",countryCode:"CN",
    regionName:"上海", city:"上海", isp:"0"
  }, {policy:"<img src=x onerror=alert(1)>"});
  assert.match(value.title, /🇨🇳 中国/);
  assert.match(value.htmlMessage, /2001:db8::1/);
  assert.match(value.htmlMessage, /IPv6/);
  assert.match(value.htmlMessage, /运营商/);
  assert.match(value.htmlMessage, /&lt;img/);
  assert.doesNotMatch(value.htmlMessage, /<img/);
  assert.doesNotMatch(value.htmlMessage, /城市.*上海.*上海/s);
});

test("task handles non-200, malformed JSON and network errors in the interactive panel", async () => {
  for (const options of [{statusCode:429},{statusCode:503},{reject:"connection timed out"}]) {
    const {value} = await executeTask(options.reject ? "" : {error:"service failed"}, options);
    assert.match(value.title, /查询失败/);
    assert.match(value.htmlMessage, /归属地查询失败/);
  }
  const {value} = await executeTask("{broken JSON");
  assert.match(value.title, /查询失败/);
});

test("task displays an error when successful GeoIP JSON lacks an exit IP", async () => {
  const {value} = await executeTask({status:"success",country:"Japan",query:""});
  assert.match(value.title, /查询失败/);
});
