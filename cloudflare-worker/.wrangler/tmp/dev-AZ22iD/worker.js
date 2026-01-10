var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-xv6tvI/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// worker.js
var ADDON_VERSION = "4.1.0-cf";
var ADDON_NAME = "AutoStream";
var BASE_COMET = "https://comet.elfhosted.com";
var BASE_NUVIO = "https://nuviostreams.hayd.uk";
var COMET_DEFAULT_CONFIG = btoa(JSON.stringify({
  debridService: "torrent",
  maxResultsPerResolution: 0,
  maxSize: 0,
  resultFormat: ["all"]
}));
function buildCometConfig(debridProvider, apiKey) {
  const providerMapping = {
    "realdebrid": "realdebrid",
    "rd": "realdebrid",
    "alldebrid": "alldebrid",
    "ad": "alldebrid",
    "premiumize": "premiumize",
    "pm": "premiumize",
    "torbox": "torbox",
    "tb": "torbox",
    "debridlink": "debridlink",
    "dl": "debridlink",
    "offcloud": "offcloud",
    "easydebrid": "easydebrid"
  };
  const debridService = providerMapping[debridProvider?.toLowerCase()] || "torrent";
  const config = {
    debridService,
    debridApiKey: apiKey || "",
    maxResultsPerResolution: 0,
    maxSize: 0,
    resultFormat: ["all"]
  };
  return btoa(JSON.stringify(config));
}
__name(buildCometConfig, "buildCometConfig");
function parsePathConfig(configPath) {
  if (!configPath) return {};
  const decoded = decodeURIComponent(configPath);
  const separator = decoded.includes("|") ? "|" : "&";
  return decoded.split(separator).reduce((map, part) => {
    const [key, value] = part.split("=");
    if (key && value) {
      map[key.toLowerCase()] = value;
    }
    return map;
  }, {});
}
__name(parsePathConfig, "parsePathConfig");
function extractDebridConfig(config) {
  const shortForms = { ad: "alldebrid", rd: "realdebrid", pm: "premiumize", tb: "torbox" };
  for (const [short, full] of Object.entries(shortForms)) {
    if (config[short]) {
      return { provider: full, apiKey: config[short] };
    }
  }
  const fullKeys = ["alldebrid", "realdebrid", "premiumize", "torbox", "debridlink", "offcloud", "easydebrid"];
  for (const key of fullKeys) {
    if (config[key]) {
      return { provider: key, apiKey: config[key] };
    }
  }
  if (config.apikey) {
    return { provider: "alldebrid", apiKey: config.apikey };
  }
  return { provider: null, apiKey: null };
}
__name(extractDebridConfig, "extractDebridConfig");
async function fetchCometStreams(type, id, debridProvider, debridApiKey) {
  const config = debridApiKey ? buildCometConfig(debridProvider, debridApiKey) : COMET_DEFAULT_CONFIG;
  const url = `${BASE_COMET}/${config}/stream/${type}/${id}.json`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Stremio" },
      cf: { cacheTtl: 300 }
      // Cache for 5 minutes
    });
    if (!response.ok) {
      console.log(`Comet returned ${response.status}`);
      return [];
    }
    const data = await response.json();
    let streams = data.streams || [];
    streams = streams.filter((s) => {
      if (!s || !s.name) return false;
      const name = s.name.toLowerCase();
      if (name.includes("\u26A0") || name.includes("\u274C") || name.includes("\u{1F422}")) return false;
      if (name.includes("rate-limit") || name.includes("disabled")) return false;
      return true;
    });
    return streams.map((s) => ({ ...s, _origin: "comet", _score: 1e3 }));
  } catch (e) {
    console.error("Comet fetch error:", e.message);
    return [];
  }
}
__name(fetchCometStreams, "fetchCometStreams");
async function fetchNuvioStreams(type, id) {
  const url = `${BASE_NUVIO}/stream/${type}/${id}.json`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Stremio" },
      cf: { cacheTtl: 300 }
    });
    if (!response.ok) {
      console.log(`Nuvio returned ${response.status}`);
      return [];
    }
    const data = await response.json();
    const streams = data.streams || [];
    return streams.map((s) => ({ ...s, _origin: "nuvio", _score: 500 }));
  } catch (e) {
    console.error("Nuvio fetch error:", e.message);
    return [];
  }
}
__name(fetchNuvioStreams, "fetchNuvioStreams");
function scoreStreams(streams) {
  return streams.map((s) => {
    let score = s._score || 0;
    const name = (s.name || "").toLowerCase();
    const title = (s.title || "").toLowerCase();
    const text = name + " " + title;
    if (text.includes("2160p") || text.includes("4k")) score += 100;
    else if (text.includes("1080p")) score += 50;
    else if (text.includes("720p")) score += 20;
    if (text.includes("x264") || text.includes("h.264")) score += 30;
    if (text.includes("x265") || text.includes("hevc")) score -= 10;
    if (s._origin === "comet") score += 200;
    return { ...s, _score: score };
  }).sort((a, b) => b._score - a._score);
}
__name(scoreStreams, "scoreStreams");
function formatStream(stream, debridProvider) {
  const providerBadge = debridProvider ? ` (${debridProvider.toUpperCase().slice(0, 2)})` : "";
  const text = ((stream.name || "") + " " + (stream.title || "")).toLowerCase();
  let resolution = "";
  if (text.includes("2160p") || text.includes("4k")) resolution = "4K";
  else if (text.includes("1080p")) resolution = "1080p";
  else if (text.includes("720p")) resolution = "720p";
  else if (text.includes("480p")) resolution = "480p";
  return {
    name: `AutoStream${providerBadge}`,
    description: resolution ? `${resolution}` : stream.title || stream.name || "Stream",
    url: stream.url,
    behaviorHints: stream.behaviorHints || {}
  };
}
__name(formatStream, "formatStream");
function generateManifest(config = {}) {
  const { provider } = extractDebridConfig(config);
  return {
    id: "com.stremio.autostream.cf",
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: `Cloudflare-powered stream aggregator with Comet${provider ? ` + ${provider}` : ""} and Nuvio`,
    logo: "https://i.imgur.com/tLzZGMf.png",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}
__name(generateManifest, "generateManifest");
async function handleStreamRequest(type, id, config) {
  const { provider, apiKey } = extractDebridConfig(config);
  const includeNuvio = config.include_nuvio === "1" || config.nuvio === "1" || !apiKey;
  console.log(`Stream request: ${type}/${id}, debrid: ${provider || "none"}, nuvio: ${includeNuvio}`);
  const promises = [
    fetchCometStreams(type, id, provider, apiKey)
  ];
  if (includeNuvio) {
    promises.push(fetchNuvioStreams(type, id));
  }
  const results = await Promise.all(promises);
  let allStreams = results.flat();
  console.log(`Total streams before scoring: ${allStreams.length}`);
  if (allStreams.length === 0) {
    return { streams: [] };
  }
  const scored = scoreStreams(allStreams);
  const topStreams = scored.slice(0, 5).map((s) => formatStream(s, provider));
  console.log(`Returning ${topStreams.length} streams`);
  return { streams: topStreams };
}
__name(handleStreamRequest, "handleStreamRequest");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (pathname === "/health" || pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        version: ADDON_VERSION,
        runtime: "cloudflare-workers"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    let configPath = "";
    let actualPath = pathname;
    const pathParts = pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      if (pathParts[0].includes("=") && (pathParts[1] === "manifest.json" || pathParts[1] === "stream")) {
        configPath = pathParts[0];
        actualPath = "/" + pathParts.slice(1).join("/");
      }
    }
    const config = parsePathConfig(configPath);
    if (actualPath === "/manifest.json") {
      const manifest = generateManifest(config);
      return new Response(JSON.stringify(manifest), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const streamMatch = actualPath.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      try {
        const result = await handleStreamRequest(type, id, config);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        console.error("Stream error:", e);
        return new Response(JSON.stringify({ streams: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

// ../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-xv6tvI/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-xv6tvI/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
