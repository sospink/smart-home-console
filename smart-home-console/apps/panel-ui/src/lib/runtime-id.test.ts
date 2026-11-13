import assert from "node:assert/strict";
import test from "node:test";
import { runtimeId } from "./runtime-id";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("安全上下文优先使用原生 randomUUID", () => {
  const expected = "12345678-1234-4123-8123-123456789abc";
  assert.equal(
    runtimeId({
      randomUUID: () => expected,
      getRandomValues: (array) => array
    }),
    expected
  );
});

test("Android HTTP WebView 缺少 randomUUID 时仍生成合法且不同的请求 ID", () => {
  let seed = 0;
  const webViewCrypto = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(++seed);
      return array;
    }
  };
  const first = runtimeId(webViewCrypto);
  const second = runtimeId(webViewCrypto);
  assert.match(first, uuidPattern);
  assert.match(second, uuidPattern);
  assert.notEqual(first, second);
});

test("WebView 暴露但拒绝 randomUUID 时回退到 getRandomValues", () => {
  const id = runtimeId({
    randomUUID: () => {
      throw new DOMException("Only secure origins are allowed", "SecurityError");
    },
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(7);
      return array;
    }
  });
  assert.match(id, uuidPattern);
});

test("极旧 WebView 没有 Web Crypto 时仍不会阻断点击交互", () => {
  const first = runtimeId(undefined);
  const second = runtimeId(undefined);
  assert.match(first, uuidPattern);
  assert.match(second, uuidPattern);
  assert.notEqual(first, second);
});
