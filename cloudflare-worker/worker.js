/**
 * AutoStream Cloudflare Worker
 * A full Stremio addon running on Cloudflare Workers edge network
 * 
 * Deploy: wrangler deploy
 * Test locally: wrangler dev
 */

const ADDON_VERSION = '4.1.0-cf';
const ADDON_NAME = 'AutoStream';

// Source URLs
const BASE_COMET = 'https://comet.elfhosted.com';
const BASE_NUVIO = 'https://nuviostreams.hayd.uk';

// Default Comet config (no debrid - will get rate limited)
const COMET_DEFAULT_CONFIG = btoa(JSON.stringify({
  debridService: "torrent",
  maxResultsPerResolution: 0,
  maxSize: 0,
  resultFormat: ["all"]
}));

/**
 * Build Comet config with debrid credentials
 */
function buildCometConfig(debridProvider, apiKey) {
  const providerMapping = {
    'realdebrid': 'realdebrid', 'rd': 'realdebrid',
    'alldebrid': 'alldebrid', 'ad': 'alldebrid',
    'premiumize': 'premiumize', 'pm': 'premiumize',
    'torbox': 'torbox', 'tb': 'torbox',
    'debridlink': 'debridlink', 'dl': 'debridlink',
    'offcloud': 'offcloud', 'easydebrid': 'easydebrid'
  };
  
  const debridService = providerMapping[debridProvider?.toLowerCase()] || 'torrent';
  
  const config = {
    debridService,
    debridApiKey: apiKey || '',
    maxResultsPerResolution: 0,
    maxSize: 0,
    resultFormat: ['all']
  };
  
  return btoa(JSON.stringify(config));
}

/**
 * Parse path-based configuration (e.g., /alldebrid=KEY&include_nuvio=1/stream/...)
 */
function parsePathConfig(configPath) {
  if (!configPath) return {};
  
  const decoded = decodeURIComponent(configPath);
  const separator = decoded.includes('|') ? '|' : '&';
  
  return decoded.split(separator).reduce((map, part) => {
    const [key, value] = part.split('=');
    if (key && value) {
      map[key.toLowerCase()] = value;
    }
    return map;
  }, {});
}

/**
 * Extract debrid credentials from config
 */
function extractDebridConfig(config) {
  // Short form mappings
  const shortForms = { ad: 'alldebrid', rd: 'realdebrid', pm: 'premiumize', tb: 'torbox' };
  
  for (const [short, full] of Object.entries(shortForms)) {
    if (config[short]) {
      return { provider: full, apiKey: config[short] };
    }
  }
  
  // Full form keys
  const fullKeys = ['alldebrid', 'realdebrid', 'premiumize', 'torbox', 'debridlink', 'offcloud', 'easydebrid'];
  for (const key of fullKeys) {
    if (config[key]) {
      return { provider: key, apiKey: config[key] };
    }
  }
  
  // Legacy
  if (config.apikey) {
    return { provider: 'alldebrid', apiKey: config.apikey };
  }
  
  return { provider: null, apiKey: null };
}

/**
 * Fetch streams from Comet
 */
async function fetchCometStreams(type, id, debridProvider, debridApiKey) {
  const config = debridApiKey 
    ? buildCometConfig(debridProvider, debridApiKey)
    : COMET_DEFAULT_CONFIG;
  
  const url = `${BASE_COMET}/${config}/stream/${type}/${id}.json`;
  
  try {
    const response = await fetch(url, { 
      headers: { 'User-Agent': 'Stremio' },
      cf: { cacheTtl: 300 } // Cache for 5 minutes
    });
    
    if (!response.ok) {
      console.log(`Comet returned ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    let streams = data.streams || [];
    
    // Filter out error/warning streams
    streams = streams.filter(s => {
      if (!s || !s.name) return false;
      const name = s.name.toLowerCase();
      if (name.includes('⚠') || name.includes('❌') || name.includes('🐢')) return false;
      if (name.includes('rate-limit') || name.includes('disabled')) return false;
      return true;
    });
    
    // Mark origin
    return streams.map(s => ({ ...s, _origin: 'comet', _score: 1000 }));
  } catch (e) {
    console.error('Comet fetch error:', e.message);
    return [];
  }
}

/**
 * Fetch streams from Nuvio
 */
async function fetchNuvioStreams(type, id) {
  const url = `${BASE_NUVIO}/stream/${type}/${id}.json`;
  
  try {
    const response = await fetch(url, { 
      headers: { 'User-Agent': 'Stremio' },
      cf: { cacheTtl: 300 }
    });
    
    if (!response.ok) {
      console.log(`Nuvio returned ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const streams = data.streams || [];
    
    // Mark origin
    return streams.map(s => ({ ...s, _origin: 'nuvio', _score: 500 }));
  } catch (e) {
    console.error('Nuvio fetch error:', e.message);
    return [];
  }
}

/**
 * Score and sort streams
 */
function scoreStreams(streams) {
  return streams.map(s => {
    let score = s._score || 0;
    const name = (s.name || '').toLowerCase();
    const title = (s.title || '').toLowerCase();
    const text = name + ' ' + title;
    
    // Resolution bonuses
    if (text.includes('2160p') || text.includes('4k')) score += 100;
    else if (text.includes('1080p')) score += 50;
    else if (text.includes('720p')) score += 20;
    
    // Codec bonuses (prefer x264 for compatibility)
    if (text.includes('x264') || text.includes('h.264')) score += 30;
    if (text.includes('x265') || text.includes('hevc')) score -= 10; // Slight penalty for TV compatibility
    
    // Debrid bonus (Comet streams are already debrid-resolved)
    if (s._origin === 'comet') score += 200;
    
    return { ...s, _score: score };
  }).sort((a, b) => b._score - a._score);
}

/**
 * Format stream for Stremio output
 */
function formatStream(stream, debridProvider) {
  const providerBadge = debridProvider ? ` (${debridProvider.toUpperCase().slice(0,2)})` : '';
  
  // Extract resolution from name/title
  const text = ((stream.name || '') + ' ' + (stream.title || '')).toLowerCase();
  let resolution = '';
  if (text.includes('2160p') || text.includes('4k')) resolution = '4K';
  else if (text.includes('1080p')) resolution = '1080p';
  else if (text.includes('720p')) resolution = '720p';
  else if (text.includes('480p')) resolution = '480p';
  
  return {
    name: `AutoStream${providerBadge}`,
    description: resolution ? `${resolution}` : (stream.title || stream.name || 'Stream'),
    url: stream.url,
    behaviorHints: stream.behaviorHints || {}
  };
}

/**
 * Generate manifest
 */
function generateManifest(config = {}) {
  const { provider } = extractDebridConfig(config);
  
  return {
    id: 'com.stremio.autostream.cf',
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: `Cloudflare-powered stream aggregator with Comet${provider ? ` + ${provider}` : ''} and Nuvio`,
    logo: 'https://i.imgur.com/tLzZGMf.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

/**
 * Handle stream request
 */
async function handleStreamRequest(type, id, config) {
  const { provider, apiKey } = extractDebridConfig(config);
  const includeNuvio = config.include_nuvio === '1' || config.nuvio === '1' || !apiKey;
  
  console.log(`Stream request: ${type}/${id}, debrid: ${provider || 'none'}, nuvio: ${includeNuvio}`);
  
  // Fetch from sources in parallel
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
  
  // Score and sort
  const scored = scoreStreams(allStreams);
  
  // Return top streams
  const topStreams = scored.slice(0, 5).map(s => formatStream(s, provider));
  
  console.log(`Returning ${topStreams.length} streams`);
  
  return { streams: topStreams };
}

/**
 * Main request handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Health check
    if (pathname === '/health' || pathname === '/') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        version: ADDON_VERSION,
        runtime: 'cloudflare-workers'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Parse path-based config: /:config/manifest.json or /:config/stream/:type/:id.json
    let configPath = '';
    let actualPath = pathname;
    
    // Check for path-based config
    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      // Check if first part contains = (config) and second part is manifest or stream
      if (pathParts[0].includes('=') && (pathParts[1] === 'manifest.json' || pathParts[1] === 'stream')) {
        configPath = pathParts[0];
        actualPath = '/' + pathParts.slice(1).join('/');
      }
    }
    
    const config = parsePathConfig(configPath);
    
    // Manifest endpoint
    if (actualPath === '/manifest.json') {
      const manifest = generateManifest(config);
      return new Response(JSON.stringify(manifest), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Stream endpoint: /stream/:type/:id.json
    const streamMatch = actualPath.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      
      try {
        const result = await handleStreamRequest(type, id, config);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        console.error('Stream error:', e);
        return new Response(JSON.stringify({ streams: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 404 for unknown paths
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
