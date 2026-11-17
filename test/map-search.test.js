import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_SEARCH_NOT_FOUND_TEXT,
  MAP_SEARCH_NO_LOCATION_TEXT,
  normalizeTagQuery,
  normalizePhoneQuery,
  looksLikeCaptainTag,
  extractCaptainCoords,
  matchLoadedCaptain,
  decideMapSearchResult,
} from '../public/map-search.js';

const CAPTAINS = [
  { id: 101, name: 'كابتن عمر', tag: 'A7K3', phone: '0931111199', lat: 33.5138, lng: 36.2765, online: true },
  { id: 102, name: 'كابتن كريم', tag: 'M9P2', phone: '0944556677', lat: null, lng: null, online: false },
  { id: 103, name: 'كابتن سارة', tag: '9081', phone: '963955001122', lat: 33.52, lng: 36.29, online: true },
];

test('normalizeTagQuery and matchLoadedCaptain handle hashtag, lowercase, spacing, and Arabic numerals', () => {
  assert.equal(normalizeTagQuery('#a7k3'), 'A7K3');
  assert.equal(normalizeTagQuery('a 7 k 3'), 'A7K3');
  assert.equal(normalizeTagQuery('#A٧K٣'), 'A7K3');

  for (const q of ['#A7K3', 'a7k3', 'A7K3', ' #a7k3 ', '#a٧k٣']) {
    const cap = matchLoadedCaptain(CAPTAINS, q);
    assert.equal(cap?.id, 101, `expected query "${q}" to match captain 101`);
  }
});

test('phone lookup normalizes spaces, dashes, Arabic numerals, and leading + or +963', () => {
  assert.equal(normalizePhoneQuery('+0931-111 199'), '0931111199');
  assert.equal(looksLikeCaptainTag('+0931-111 199'), '');
  assert.equal(looksLikeCaptainTag('0931 111 199'), '');
  assert.equal(looksLikeCaptainTag('ZZZZ'), 'ZZZZ');

  for (const q of ['+0931-111 199', '0931 111 199', '+963 931-111-199', '٠٠٩٦٣٩٣١١١١١٩٩']) {
    const cap = matchLoadedCaptain(CAPTAINS, q);
    assert.equal(cap?.id, 101, `expected phone query "${q}" to match captain 101`);
  }

  // Matches captain stored in 963... format when searched locally as 09...
  assert.equal(matchLoadedCaptain(CAPTAINS, '0955 001 122')?.id, 103);
});

test('unknown code resolves to not_found Arabic message without moving map or opening details', () => {
  assert.equal(matchLoadedCaptain(CAPTAINS, 'UNKNOWN99'), null);
  const decision = decideMapSearchResult({ captain: null, query: '#UNKNOWN99' });
  assert.equal(decision.action, 'not_found');
  assert.equal(decision.message, MAP_SEARCH_NOT_FOUND_TEXT);
  assert.equal(decision.moveMap, false);
  assert.equal(decision.openDetails, false);
  assert.equal(decision.highlightCaptainId, null);
});

test('captain with missing location shows no-location message and never moves map', () => {
  const noLocCap = matchLoadedCaptain(CAPTAINS, 'M9P2');
  assert.equal(noLocCap?.id, 102);

  const decision = decideMapSearchResult({ captain: noLocCap, query: 'M9P2' });
  assert.equal(decision.action, 'no_location');
  assert.equal(decision.message, MAP_SEARCH_NO_LOCATION_TEXT);
  assert.equal(decision.moveMap, false);
  assert.equal(decision.openDetails, false);
  assert.equal(decision.highlightCaptainId, null);
});

test('captain with valid coords (live lat/lng or by-tag last_lat/last_lng) focuses zoom 16 and keeps details closed', () => {
  const byTagPayload = { id: 205, name: 'كابتن زياد', tag: 'Z88Q', last_lat: 33.501, last_lng: 36.288 };
  assert.deepEqual(extractCaptainCoords(byTagPayload), { lat: 33.501, lng: 36.288 });

  const decision = decideMapSearchResult({ captain: byTagPayload, query: '#z88q' });
  assert.equal(decision.action, 'focus');
  assert.equal(decision.moveMap, true);
  assert.equal(decision.zoom, 16);
  assert.equal(decision.lat, 33.501);
  assert.equal(decision.lng, 36.288);
  assert.equal(decision.openDetails, false);
  assert.equal(decision.highlightCaptainId, 205);
});
