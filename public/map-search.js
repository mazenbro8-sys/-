export const MAP_SEARCH_NOT_FOUND_TEXT = 'ما فيه كابتن بهذا الكود أو الرقم';
export const MAP_SEARCH_NO_LOCATION_TEXT = 'لا يوجد موقع معروف لهذا الكابتن';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Convert Arabic/Persian numerals to ASCII digits.
 */
export function toEnDigitsLocal(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d));
}

export const MARKER_STATUS_COLORS = Object.freeze({
  green: '#10B981',
  blue: '#3B82F6',
  yellow: '#06B6D4',
  gray: '#94A3B8',
  neutral: '#94A3B8',
});

/**
 * Return dot/icon status color, shape (`circle` for captain, `square` for merchant), and border style.
 */
export function getMarkerStatusAppearance({ kind = 'captain', stateKey = 'gray' } = {}) {
  const normalizedKey = Object.hasOwn(MARKER_STATUS_COLORS, stateKey) ? stateKey : 'gray';
  const isMerchant = kind === 'merchant';
  const pulsing = normalizedKey === 'green' || normalizedKey === 'blue' || normalizedKey === 'yellow';
  const stateClasses = [`ops-state-${normalizedKey}`];
  if (pulsing) stateClasses.push('ops-pulsing');
  if (!isMerchant && normalizedKey === 'gray') stateClasses.push('ops-offline');
  return {
    stateKey: normalizedKey,
    color: MARKER_STATUS_COLORS[normalizedKey],
    shape: isMerchant ? 'square' : 'circle',
    borderStyle: !isMerchant && normalizedKey === 'gray' ? 'dashed' : normalizedKey === 'neutral' ? 'dotted' : 'solid',
    stateClass: stateClasses.join(' '),
  };
}

/**
 * Return zoom-responsive visible marker style/size while keeping a >= 48px hit box:
 * - zoom <= 13: plain 12px colored dot (no glyph/secondary label)
 * - zoom 14 (13 < zoom < 15): 24px small icon
 * - zoom >= 15: 34px full icon
 */
export function getMarkerVisualSize(zoom) {
  const z = Number(zoom);
  const effectiveZoom = Number.isFinite(z) ? z : 12;
  if (effectiveZoom <= 13) {
    return { mode: 'dot', pinSize: 12, hitSize: 48, showGlyph: false, showSecondary: false, tier: 'dot' };
  }
  if (effectiveZoom < 15) {
    return { mode: 'small', pinSize: 24, hitSize: 48, showGlyph: true, showSecondary: true, tier: 'sm' };
  }
  return { mode: 'full', pinSize: 34, hitSize: 48, showGlyph: true, showSecondary: true, tier: 'lg' };
}

/**
 * Normalize a captain code query (`#A7K3`, `a7k3`, spaces, Arabic digits -> `A7K3`).
 */
export function normalizeTagQuery(raw) {
  return toEnDigitsLocal(raw)
    .trim()
    .replace(/[#\s\-]+/g, '')
    .toUpperCase();
}

/**
 * Normalize a phone query by converting numerals and stripping spaces, dashes, parens, and leading `+`.
 */
export function normalizePhoneQuery(raw) {
  const ascii = toEnDigitsLocal(raw).trim();
  if (!ascii || ascii.startsWith('#')) return '';
  return ascii.replace(/[\s\-()]+/g, '').replace(/^\+/, '');
}

/**
 * Generate equivalent phone lookup forms (local `09...` and `+963`/`00963` international forms).
 */
export function getPhoneLookupVariants(raw) {
  const ascii = toEnDigitsLocal(raw).trim();
  if (!ascii || ascii.startsWith('#')) return [];
  const compact = ascii.replace(/[\s\-()]+/g, '');
  if (!/^\+?\d{7,15}$/.test(compact)) return [];
  const base = compact.replace(/^\+/, '');
  const forms = new Set([base]);

  if (/^00963\d{8,10}$/.test(base)) {
    const rest = base.slice(5);
    forms.add(`0${rest}`);
    forms.add(`963${rest}`);
    forms.add(rest);
  } else if (/^963\d{8,10}$/.test(base)) {
    const rest = base.slice(3);
    forms.add(`0${rest}`);
    forms.add(rest);
  } else if (/^09\d{7,9}$/.test(base)) {
    const rest = base.slice(1);
    forms.add(`963${rest}`);
    forms.add(`00963${rest}`);
    forms.add(rest);
  } else if (/^9\d{8}$/.test(base)) {
    forms.add(`0${base}`);
    forms.add(`963${base}`);
  }
  return [...forms];
}

/**
 * Return normalized tag for `/captains/by-tag/:tag` fallback, or empty string if input looks like a phone number or invalid tag.
 */
export function looksLikeCaptainTag(raw) {
  const ascii = toEnDigitsLocal(raw).trim();
  if (!ascii) return '';
  const explicitHash = ascii.startsWith('#');
  const code = normalizeTagQuery(ascii);
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return '';

  if (!explicitHash) {
    const compactPhone = ascii.replace(/[\s\-()]+/g, '');
    if (compactPhone.startsWith('+')) return '';
    if (/^(?:00963|963|09)\d{7,10}$/.test(compactPhone)) return '';
  }
  return code;
}

/**
 * Extract finite `{ lat, lng }` coordinates from live (`lat`/`lng`) or by-tag (`last_lat`/`last_lng`) captain payloads.
 */
export function extractCaptainCoords(captain) {
  if (!captain || typeof captain !== 'object') return null;
  const rawLat = captain.lat ?? captain.last_lat;
  const rawLng = captain.lng ?? captain.last_lng;
  if (rawLat == null || rawLng == null) return null;
  if (typeof rawLat === 'string' && rawLat.trim() === '') return null;
  if (typeof rawLng === 'string' && rawLng.trim() === '') return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Match a captain in an already-loaded array (`liveCache.captains`) by normalized tag or normalized phone.
 */
export function matchLoadedCaptain(captains, rawQuery) {
  const list = Array.isArray(captains) ? captains : [];
  const ascii = toEnDigitsLocal(rawQuery).trim();
  if (!ascii || !list.length) return null;

  const hasHash = ascii.startsWith('#');
  const codeQuery = normalizeTagQuery(ascii);
  if (codeQuery) {
    const byTag = list.find((c) => c?.tag && normalizeTagQuery(c.tag) === codeQuery);
    if (byTag) return byTag;
  }

  if (hasHash) return null;

  const queryPhones = getPhoneLookupVariants(ascii);
  if (!queryPhones.length) return null;
  const querySet = new Set(queryPhones);

  return (
    list.find((c) => {
      if (!c?.phone) return false;
      return getPhoneLookupVariants(c.phone).some((variant) => querySet.has(variant));
    }) || null
  );
}

/**
 * Compute map search action without side effects (whether to focus map, highlight marker, or show error/warning status).
 */
export function decideMapSearchResult({ captain, query }) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) {
    return {
      action: 'empty',
      tone: 'neutral',
      icon: 'ℹ️',
      message: 'اكتب كود الكابتن أو رقم هاتفه',
      moveMap: false,
      zoom: null,
      lat: null,
      lng: null,
      openDetails: false,
      highlightCaptainId: null,
      captain: null,
    };
  }

  if (!captain) {
    return {
      action: 'not_found',
      tone: 'error',
      icon: '✕',
      message: MAP_SEARCH_NOT_FOUND_TEXT,
      moveMap: false,
      zoom: null,
      lat: null,
      lng: null,
      openDetails: false,
      highlightCaptainId: null,
      captain: null,
    };
  }

  const coords = extractCaptainCoords(captain);
  if (!coords) {
    return {
      action: 'no_location',
      tone: 'warning',
      icon: '⚠',
      message: MAP_SEARCH_NO_LOCATION_TEXT,
      moveMap: false,
      zoom: null,
      lat: null,
      lng: null,
      openDetails: false,
      highlightCaptainId: null,
      captain,
    };
  }

  const label = captain.name || captain.tag || `#${captain.id}`;
  return {
    action: 'focus',
    tone: 'ok',
    icon: '✓',
    message: `تم تحديد الكابتن: ${label}`,
    moveMap: true,
    zoom: 16,
    lat: coords.lat,
    lng: coords.lng,
    openDetails: false,
    highlightCaptainId: captain.id ?? null,
    captain,
  };
}
