import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_STATUS_COLORS,
  getMarkerStatusAppearance,
  getMarkerVisualSize,
} from '../public/map-search.js';
import { getCaptainVisualState } from '../public/live-state.js';

test('zoom levels map to dot (<=13 -> 12px), small icon (14 -> 24px), full icon (>=15 -> 34px), and >=48px hit box', () => {
  for (const z of [5, 10, 11, 12, 13]) {
    const s = getMarkerVisualSize(z);
    assert.equal(s.mode, 'dot', `zoom ${z} mode`);
    assert.equal(s.tier, 'dot', `zoom ${z} tier`);
    assert.equal(s.pinSize, 12, `zoom ${z} pinSize`);
    assert.ok(s.hitSize >= 48, `zoom ${z} hitSize >= 48`);
    assert.equal(s.showGlyph, false, `zoom ${z} hides icon glyph inside dot`);
    assert.equal(s.showSecondary, false, `zoom ${z} hides secondary text`);
  }

  for (const z of [13.5, 14, 14.5, 14.9]) {
    const s = getMarkerVisualSize(z);
    assert.equal(s.mode, 'small', `zoom ${z} mode`);
    assert.equal(s.tier, 'sm', `zoom ${z} tier`);
    assert.equal(s.pinSize, 24, `zoom ${z} pinSize`);
    assert.ok(s.hitSize >= 48, `zoom ${z} hitSize >= 48`);
    assert.equal(s.showGlyph, true, `zoom ${z} shows small icon glyph`);
    assert.equal(s.showSecondary, true, `zoom ${z} shows secondary text`);
  }

  for (const z of [15, 16, 18, 20]) {
    const s = getMarkerVisualSize(z);
    assert.equal(s.mode, 'full', `zoom ${z} mode`);
    assert.equal(s.tier, 'lg', `zoom ${z} tier`);
    assert.equal(s.pinSize, 34, `zoom ${z} pinSize`);
    assert.ok(s.hitSize >= 48, `zoom ${z} hitSize >= 48`);
    assert.equal(s.showGlyph, true, `zoom ${z} shows full icon glyph`);
    assert.equal(s.showSecondary, true, `zoom ${z} shows secondary text`);
  }
});

test('hit box remains at least 48px and invalid zoom falls back to 12px dot safely', () => {
  for (const z of [undefined, null, NaN, 'abc']) {
    const s = getMarkerVisualSize(z);
    assert.equal(s.mode, 'dot');
    assert.equal(s.pinSize, 12);
    assert.ok(s.hitSize >= 48);
    assert.equal(s.showGlyph, false);
    assert.equal(s.showSecondary, false);
  }
});

test('dot color and shape rules preserve status colors and differentiate captains vs merchants', () => {
  // Captain states match getCaptainVisualState colors
  const greenCap = getCaptainVisualState({ id: 1, online: true }, [{ id: 10, captain_id: 1, status: 'picked_up' }]);
  const blueCap = getCaptainVisualState({ id: 2, online: true }, [{ id: 11, captain_id: 2, status: 'accepted' }]);
  const yellowCap = getCaptainVisualState({ id: 3, online: true }, []);
  const grayCap = getCaptainVisualState({ id: 4, online: false }, []);

  assert.equal(getMarkerStatusAppearance({ kind: 'captain', stateKey: greenCap.stateKey }).color, MARKER_STATUS_COLORS.green);
  assert.equal(getMarkerStatusAppearance({ kind: 'captain', stateKey: blueCap.stateKey }).color, MARKER_STATUS_COLORS.blue);
  assert.equal(getMarkerStatusAppearance({ kind: 'captain', stateKey: yellowCap.stateKey }).color, MARKER_STATUS_COLORS.yellow);
  assert.equal(getMarkerStatusAppearance({ kind: 'captain', stateKey: grayCap.stateKey }).color, MARKER_STATUS_COLORS.gray);

  // Shape differentiation: captains use circles, merchants use squares
  const capDot = getMarkerStatusAppearance({ kind: 'captain', stateKey: 'yellow' });
  const offDot = getMarkerStatusAppearance({ kind: 'captain', stateKey: 'gray' });
  const merchWaitingDot = getMarkerStatusAppearance({ kind: 'merchant', stateKey: 'yellow' });
  const merchActiveDot = getMarkerStatusAppearance({ kind: 'merchant', stateKey: 'green' });
  const merchIdleDot = getMarkerStatusAppearance({ kind: 'merchant', stateKey: 'neutral' });

  assert.equal(capDot.shape, 'circle');
  assert.equal(capDot.borderStyle, 'solid');
  assert.equal(offDot.shape, 'circle');
  assert.equal(offDot.borderStyle, 'dashed');

  assert.equal(merchWaitingDot.shape, 'square');
  assert.equal(merchWaitingDot.color, MARKER_STATUS_COLORS.yellow);
  assert.equal(merchActiveDot.shape, 'square');
  assert.equal(merchActiveDot.color, MARKER_STATUS_COLORS.green);
  assert.equal(merchIdleDot.shape, 'square');
  assert.equal(merchIdleDot.color, MARKER_STATUS_COLORS.neutral);
  assert.equal(merchIdleDot.borderStyle, 'dotted');
});
