/* =====================================================================
 * 我的200平花园 · PWA Service Worker
 * 策略：
 *   1) App Shell + data/plants.json 安装时预缓存，离线可直接打开
 *   2) ./images/ 图片 Cache-First，按需缓存并后台全量预热
 *   3) 页面导航 Network-First，断网回退缓存的 index.html
 *   4) 天气接口 Network-First，断网回退最近一次结果
 * ===================================================================== */
const VERSION = "garden-sw-v11";
const SHELL_CACHE = VERSION + "-shell";
const IMG_CACHE = VERSION + "-img";
const RUNTIME_CACHE = VERSION + "-runtime";
const IMG_LIMIT = 600;

/* 安装即缓存，保证断网首屏可用 */
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./data/plants.json",
  "./images/icon-192.png",
  "./images/icon-512.png",
  "./images/apple-touch-icon.png",
  "./images/icon-maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(
        APP_SHELL.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => ![SHELL_CACHE, IMG_CACHE, RUNTIME_CACHE].includes(k))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- 缓存策略 ---------- */

/* 页面导航：网络优先，断网回退 index.html */
function navigationFallback(request) {
  return fetch(request)
    .then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put("./index.html", copy));
      }
      return res;
    })
    .catch(() => caches.match("./index.html").then(r => r || new Response(
      "<h1>离线</h1><p>请联网后重新打开一次以完成资源缓存。</p>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    )));
}

/* 图片：缓存优先，未命中再走网络并写入缓存 */
function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res && res.status === 200) {
          cache.put(request, res.clone());
          trimCache(cacheName, IMG_LIMIT);
        }
        return res;
      });
    })
  );
}

/* 先返回缓存、后台更新 */
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const network = fetch(request).then(res => {
        if (res && res.status === 200) cache.put(request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
}

/* 网络优先，失败回退缓存。
   手机上必须加超时：网络慢时先给缓存秒开，网络结果稍后写入缓存备用 */
function networkFirst(request, cacheName, timeoutMs = 4000) {
  return caches.open(cacheName).then(cache => {
    const net = fetch(request, { cache: "no-store" })
      .then(res => {
        if (res && res.status === 200) cache.put(request, res.clone());
        return res;
      })
      .catch(() => undefined);
    const timer = new Promise(resolve => setTimeout(resolve, timeoutMs));
    return Promise.race([
      net.then(res => res || cache.match(request)),
      timer.then(() => cache.match(request))
    ]).then(res => res || net.then(r => r || cache.match(request)))
      .then(res => res || new Response("", { status: 504 }));
  });
}

function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then(cache =>
    cache.keys().then(keys => {
      if (keys.length <= maxItems) return;
      Promise.all(keys.slice(0, keys.length - maxItems).map(k => cache.delete(k)));
    })
  );
}

/* ---------- fetch 路由 ---------- */
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  /* 跨域：仅接管天气接口 */
  if (url.origin !== self.location.origin) {
    if (url.hostname.endsWith("open-meteo.com")) {
      event.respondWith(networkFirst(request, RUNTIME_CACHE));
    }
    return;
  }

  /* 页面导航 */
  if (request.mode === "navigate") {
    event.respondWith(navigationFallback(request));
    return;
  }

  /* 静态字典：网络优先（保证新增/修改的植物数据立即可见），断网/弱网回退缓存。
     超时设 2.5 秒，略早于页面的 3 秒兜底，避免手机上一打开就整页等待 */
  if (url.pathname.endsWith("/plants.json")) {
    event.respondWith(networkFirst(request, SHELL_CACHE, 2500));
    return;
  }

  /* 本地图片：缓存优先 */
  if (url.pathname.includes("/images/")) {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  /* 其余同源资源 */
  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});

/* ---------- 后台预热全部植物图片（低速串行，避免拖慢手机） ---------- */
async function warmImages() {
  try {
    /* 省流量模式或弱网直接跳过预热，优先保证当前页面正常加载 */
    const conn = self.navigator.connection || {};
    if (conn.saveData) return;
    if (/(^|-)2g$|(^|-)3g$/.test(conn.effectiveType || "")) return;

    const res = await fetch("./data/plants.json", { cache: "no-store" });
    if (!res.ok) return;
    const list = await res.json();
    const urls = new Set();
    (list || []).forEach(p => {
      const m = p.media || {};
      ["cover_image", "main", "flower", "leaf"].forEach(k => {
        const it = m[k];
        if (it && it.url) urls.add(it.url);
      });
      if (Array.isArray(m.gallery)) {
        m.gallery.forEach(it => { if (it && it.url) urls.add(it.url); });
      }
    });
    const arr = [...urls];
    if (!arr.length) return;
    const cache = await caches.open(IMG_CACHE);
    /* 串行下载：一次只用一条连接，每 3 张歇 300ms，不抢占页面带宽 */
    for (let i = 0; i < arr.length; i++) {
      try {
        if (await cache.match(arr[i])) continue;
        const r = await fetch(arr[i]);
        if (r && r.status === 200) await cache.put(arr[i], r);
      } catch (e) { /* 单张失败不影响整体 */ }
      if (i % 3 === 2) await new Promise(r => setTimeout(r, 300));
    }
    trimCache(IMG_CACHE, IMG_LIMIT);
  } catch (e) { /* 离线或数据异常时静默跳过 */ }
}

self.addEventListener("message", event => {
  if (event.data && event.data.type === "CACHE_IMAGES") {
    event.waitUntil(warmImages());
  }
});
