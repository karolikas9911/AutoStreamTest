/**
 * AutoStream CF Proxy Worker
 * Simple proxy to bypass IP blocks from cloud providers (Render, Vercel, etc.)
 * 
 * Deploy as separate worker: wrangler deploy --name autostream-proxy -c wrangler-proxy.toml
 * 
 * Usage: https://your-proxy.workers.dev/?url=https://comet.elfhosted.com/...
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        }
      });
    }
    
    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        service: 'autostream-proxy',
        usage: 'Add ?url=https://target-url.com/path to proxy requests'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Get target URL from query param
    const targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
      return new Response(JSON.stringify({ 
        error: 'Missing url parameter',
        usage: 'Add ?url=https://target-url.com/path to proxy requests'
      }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Validate URL
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Whitelist allowed domains (prevent abuse)
    const allowedDomains = [
      'comet.elfhosted.com',
      'comet.feels.legal',  // Official Comet instance (alternative)
      'mediafusion.elfhosted.com',
      'torrentio.strem.fun',
      'thepiratebay-plus.strem.fun',
      'nuviostreams.hayd.uk',
      'v3-cinemeta.strem.io',
      'api.alldebrid.com',
      'api.real-debrid.com'
    ];
    
    if (!allowedDomains.some(domain => parsedTarget.hostname.endsWith(domain))) {
      return new Response(JSON.stringify({ 
        error: 'Domain not allowed',
        allowed: allowedDomains 
      }), {
        status: 403,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    try {
      // Forward the request - IMPORTANT: Use 'Stremio' User-Agent
      // Comet/ElfHosted may rate-limit non-Stremio user agents more aggressively
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          'User-Agent': 'Stremio',
          'Accept': 'application/json',
        },
        body: request.method !== 'GET' ? request.body : undefined,
        // Use CF cache to reduce load on target servers and avoid rate limits
        cf: {
          cacheTtl: 300, // Cache for 5 minutes
          cacheEverything: true
        }
      });
      
      // Clone response to check content without consuming the body
      const clonedResponse = response.clone();
      let shouldCache = true;
      
      // Don't cache empty stream responses - they may be temporary failures
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await clonedResponse.json();
          // If streams array is empty or missing, don't cache
          if (!data.streams || data.streams.length === 0) {
            shouldCache = false;
          }
        }
      } catch (e) {
        // If we can't parse JSON, still return the response but don't cache
        shouldCache = false;
      }
      
      // Return response with CORS headers
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      // Only cache if we got valid streams
      newHeaders.set('Cache-Control', shouldCache ? 'public, max-age=300' : 'no-store, no-cache');
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
      
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Proxy request failed',
        message: error.message 
      }), {
        status: 502,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
