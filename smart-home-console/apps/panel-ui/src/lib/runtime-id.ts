let fallbackSequence = 0;

type RuntimeCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

/**
 * 生成仅用于请求幂等和前端临时记录的 UUID。
 *
 * Android WebView 当前从 http://appassets.androidplatform.net 加载页面。该地址不是
 * Secure Context，部分 WebView 会保留 crypto.getRandomValues()，却不提供
 * crypto.randomUUID()。直接调用 randomUUID 会在用户点击控制按钮时同步抛错，导致
 * 命令没有发出，连失败提示也无法创建。
 */
export function runtimeId(runtimeCrypto: RuntimeCrypto | undefined = globalThis.crypto): string {
  if (typeof runtimeCrypto?.randomUUID === "function") {
    try {
      return runtimeCrypto.randomUUID();
    } catch {
      // 某些 WebView 暴露方法但会因非安全上下文拒绝调用，继续使用兼容路径。
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof runtimeCrypto?.getRandomValues === "function") {
    try {
      runtimeCrypto.getRandomValues(bytes);
    } catch {
      fillFallbackBytes(bytes);
    }
  } else {
    fillFallbackBytes(bytes);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fillFallbackBytes(bytes: Uint8Array) {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  let seed = (Date.now() ^ fallbackSequence ^ Math.floor(Math.random() * 0x1_0000_0000)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    // xorshift32 只承担非安全请求 ID 的唯一性回退，不用于令牌或任何凭据。
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[index] = seed & 0xff;
  }
}
