export class GeoParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeoParseError';
  }
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function isGoogleComHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'google.com' || h.endsWith('.google.com');
}

export function isShortGoogleMapsUrl(url) {
  const h = String(url?.hostname || '').toLowerCase();
  const p = String(url?.pathname || '');
  if (h === 'maps.app.goo.gl') return true;
  if (h === 'goo.gl' && (p === '/maps' || p.startsWith('/maps/'))) return true;
  return false;
}

export function validateParsedCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new GeoParseError('إحداثيات الرابط غير صالحة');
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new GeoParseError('إحداثيات الرابط خارج النطاق الصالح (-90..90, -180..180)');
  }
  if (lat === 0 && lng === 0) {
    throw new GeoParseError('الإحداثيات (0, 0) غير صالحة، يرجى استخدام الحقول اليدوية أو الخريطة');
  }
  return { lat, lng };
}

/**
 * Extract raw coordinate numbers from a Google Maps URL without validating bounds.
 * Priority: exact pin (!3d...!4d...) > query params (?q= / ?ll=) > viewport (@lat,lng).
 */
export function extractCoordsFromGoogleUrl(url) {
  const rawCombined = `${url.pathname}${url.search}${url.hash}`;
  const decodedCombined = safeDecode(rawCombined);

  for (const text of [rawCombined, decodedCombined]) {
    const dataMatch = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (dataMatch) {
      return { lat: Number(dataMatch[1]), lng: Number(dataMatch[2]), source: 'data' };
    }
  }

  for (const key of ['q', 'll']) {
    const val = url.searchParams.get(key);
    if (!val) continue;
    const coordMatch = val.match(/^\s*(?:loc:)?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:\([^)]*\))?\s*$/i);
    if (coordMatch) {
      return { lat: Number(coordMatch[1]), lng: Number(coordMatch[2]), source: key };
    }
  }

  for (const text of [url.pathname + url.hash, safeDecode(url.pathname + url.hash), rawCombined, decodedCombined]) {
    const atMatch = text.match(/@(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?=[,/?&#z]|$)/);
    if (atMatch) {
      return { lat: Number(atMatch[1]), lng: Number(atMatch[2]), source: 'at' };
    }
  }

  return null;
}

/**
 * Parse a Google Maps share URL and extract validated { lat, lng, source }.
 * Short links (maps.app.goo.gl, goo.gl/maps) are resolved via manual redirect hops
 * capped at 5s total and max 3 redirects, only allowing google.com destinations.
 */
export async function resolveAndParseGoogleMapsLink(
  rawInput,
  { fetchImpl = globalThis.fetch, timeoutMs = 5000, maxRedirects = 3 } = {}
) {
  if (typeof rawInput !== 'string') {
    throw new GeoParseError('يرجى لصق رابط Google Maps أولاً');
  }
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new GeoParseError('رابط غير صالح أو طويل جداً');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GeoParseError('يرجى إدخال رابط URL صالح يبدأ بـ https://');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GeoParseError('نوع الرابط غير مدعوم، يرجى استخدام رابط Google Maps');
  }

  const isDirectGoogle = isGoogleComHost(url.hostname);
  const isShort = isShortGoogleMapsUrl(url);
  if (!isDirectGoogle && !isShort) {
    throw new GeoParseError('يجب أن يكون الرابط من نطاق Google Maps (google.com أو maps.app.goo.gl أو goo.gl/maps)');
  }

  let finalUrl = url;
  let usedShortLink = false;

  if (isShort) {
    usedShortLink = true;
    const deadline = Date.now() + timeoutMs;
    let current = url;
    let redirects = 0;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new GeoParseError('انتهت مهلة فتح الرابط المختصر (5 ثوانٍ)، يرجى استخدام الحقول اليدوية أو الخريطة');
      }

      let resp;
      try {
        resp = await fetchImpl(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(remaining),
          headers: {
            'User-Agent': 'MashwarDelivery/1.0',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
      } catch (err) {
        if (err instanceof GeoParseError) throw err;
        throw new GeoParseError('تعذّر الاتصال بالرابط المختصر، يرجى إدخال الإحداثيات أو التحديد على الخريطة يدوياً');
      }

      const status = Number(resp?.status || 0);
      if (status >= 300 && status < 400) {
        try { resp.body?.cancel?.().catch?.(() => {}); } catch {}
        const loc = resp.headers?.get?.('location') ?? resp.headers?.location;
        if (!loc) break;

        redirects += 1;
        if (redirects > maxRedirects) {
          throw new GeoParseError('تجاوز الرابط الحد الأقصى لإعادة التوجيه (3)، يرجى استخدام الحقول اليدوية');
        }

        let nextUrl;
        try {
          nextUrl = new URL(loc, current);
        } catch {
          throw new GeoParseError('الرابط يحتوي على إعادة توجيه غير صالحة');
        }

        if (nextUrl.protocol !== 'https:' && nextUrl.protocol !== 'http:') {
          throw new GeoParseError('بروتوكول إعادة التوجيه غير مدعوم');
        }
        if (!isGoogleComHost(nextUrl.hostname) && !isShortGoogleMapsUrl(nextUrl)) {
          throw new GeoParseError('الرابط المختصر يحول إلى موقع خارج نطاق google.com وتم رفضه');
        }

        current = nextUrl;
        if (isGoogleComHost(current.hostname) && extractCoordsFromGoogleUrl(current)) {
          break;
        }
        continue;
      }

      try { resp.body?.cancel?.().catch?.(() => {}); } catch {}
      break;
    }

    if (!isGoogleComHost(current.hostname)) {
      throw new GeoParseError('الرابط المختصر لم ينتهِ على نطاق google.com وتم رفضه');
    }
    finalUrl = current;
  }

  const extracted = extractCoordsFromGoogleUrl(finalUrl);
  if (!extracted) {
    throw new GeoParseError('لم يتم العثور على إحداثيات في هذا الرابط. يرجى إدخال خط العرض والطول يدوياً أو النقر على الخريطة.');
  }

  const { lat, lng } = validateParsedCoords(extracted.lat, extracted.lng);
  return {
    lat,
    lng,
    source: usedShortLink ? 'short_link' : extracted.source,
  };
}
