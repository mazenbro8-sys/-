import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALARM_SOUNDS,
  CAPTAIN_TONES,
  normalizeCaptainTone,
  normalizeAdminTone,
  playCaptainTone,
  playAdminTone,
} from '../public/shared.js';

function createMockAudioContext(now = 10) {
  const oscillators = [];
  const gains = [];
  const createAudioParam = (initial = 0) => {
    const events = [];
    return {
      value: initial,
      events,
      setValueAtTime(v, t) { events.push({ op: 'set', v, t }); },
      linearRampToValueAtTime(v, t) { events.push({ op: 'linear', v, t }); },
      exponentialRampToValueAtTime(v, t) { events.push({ op: 'exp', v, t }); },
    };
  };
  return {
    currentTime: now,
    destination: { kind: 'destination' },
    oscillators,
    gains,
    createOscillator() {
      const freqEvents = [];
      const osc = {
        type: 'sine',
        frequency: {
          value: 440,
          events: freqEvents,
          setValueAtTime(v, t) { freqEvents.push({ op: 'set', v, t }); },
          linearRampToValueAtTime(v, t) { freqEvents.push({ op: 'linear', v, t }); },
        },
        connectedTo: [],
        startedAt: null,
        stoppedAt: null,
        stoppedCalls: 0,
        disconnectedCalls: 0,
        connect(dest) { this.connectedTo.push(dest); },
        start(t = 0) { this.startedAt = t; },
        stop(t) {
          this.stoppedCalls += 1;
          if (t !== undefined) this.stoppedAt = t;
        },
        disconnect() { this.disconnectedCalls += 1; },
      };
      oscillators.push(osc);
      return osc;
    },
    createGain() {
      const g = {
        gain: createAudioParam(1),
        connectedTo: [],
        disconnectedCalls: 0,
        connect(dest) { this.connectedTo.push(dest); },
        disconnect() { this.disconnectedCalls += 1; },
      };
      gains.push(g);
      return g;
    },
  };
}

test('CAPTAIN_TONES defines the single approved order_melody preset while ALARM_SOUNDS stays intact for admin', () => {
  assert.equal(ALARM_SOUNDS.length, 5);
  assert.equal(CAPTAIN_TONES.length, 1);
  assert.deepEqual(
    CAPTAIN_TONES.map((t) => ({ id: t.id, key: t.key, label: t.label, repeatMs: t.repeatMs })),
    [{ id: 'order_melody', key: 'order_melody', label: 'نغمة الطلب الجديد', repeatMs: 2720 }]
  );
});

test('normalizeCaptainTone always returns order_melody regardless of input', () => {
  for (const anyKey of [
    'order_melody', 'triple', 'rising', 'bell', 'sweep',
    'classic', 'rapid', 'high', 'double_pulse', 'calm', 'soft_bell',
    null, undefined, '', 'unknown',
  ]) {
    assert.equal(normalizeCaptainTone(anyKey), 'order_melody');
  }
});

test('normalizeAdminTone defaults to "default" and supports all 5 library sounds', () => {
  assert.equal(normalizeAdminTone(null), 'default');
  assert.equal(normalizeAdminTone(''), 'default');
  assert.equal(normalizeAdminTone('default'), 'default');
  assert.equal(normalizeAdminTone('unknown_tone'), 'default');
  for (const s of ALARM_SOUNDS) {
    assert.equal(normalizeAdminTone(s.id), s.id);
  }
  assert.equal(normalizeAdminTone('pulse'), 'double_pulse');
  assert.equal(normalizeAdminTone('soft_bell'), 'calm');
});

test('playCaptainTone synthesizes the fixed 4-note order_melody with 2nd harmonics, 40ms gaps, 1800ms rest, peak 0.42, and 8ms fades', () => {
  const expectedNotes = [
    { freq: 880, harmonic: 1760, start: 0.0, dur: 0.16 },
    { freq: 1100, harmonic: 2200, start: 0.2, dur: 0.16 },
    { freq: 1320, harmonic: 2640, start: 0.4, dur: 0.16 },
    { freq: 1760, harmonic: 3520, start: 0.6, dur: 0.32 },
  ];

  for (const inputTone of [undefined, 'order_melody', 'triple', 'rising', 'invalid_tone']) {
    const actx = createMockAudioContext(10);
    const phrase = playCaptainTone(actx, inputTone);
    assert.equal(phrase.repeatMs, 2720);
    assert.equal(phrase.repeatMs - 920, 1800, 'Silence after note 4 must be 1800 ms');
    assert.equal(actx.oscillators.length, 8, '4 notes x (fundamental + 2nd harmonic) = 8 oscillators');

    expectedNotes.forEach((note, nIdx) => {
      const fundOsc = actx.oscillators[nIdx * 2];
      const harmOsc = actx.oscillators[nIdx * 2 + 1];
      const fundGain = actx.gains[nIdx * 2].gain.events;
      const harmGain = actx.gains[nIdx * 2 + 1].gain.events;

      assert.equal(fundOsc.type, 'triangle');
      assert.equal(harmOsc.type, 'triangle');
      assert.equal(Number((fundOsc.startedAt - 10).toFixed(3)), note.start);
      assert.equal(Number((harmOsc.startedAt - 10).toFixed(3)), note.start);
      assert.equal(Number((fundOsc.stoppedAt - fundOsc.startedAt).toFixed(3)), note.dur);
      assert.equal(Number((harmOsc.stoppedAt - harmOsc.startedAt).toFixed(3)), note.dur);
      assert.equal(fundOsc.frequency.events[0].v, note.freq);
      assert.equal(harmOsc.frequency.events[0].v, note.harmonic);

      assert.equal(Number((fundGain[1].t - fundOsc.startedAt).toFixed(3)), 0.008);
      assert.equal(Number((fundOsc.stoppedAt - fundGain[2].t).toFixed(3)), 0.008);
      assert.equal(Number(fundGain[1].v.toFixed(2)), 0.42);
      assert.equal(Number((harmGain[1].t - harmOsc.startedAt).toFixed(3)), 0.008);
      assert.equal(Number((harmOsc.stoppedAt - harmGain[2].t).toFixed(3)), 0.008);
      assert.equal(Number(harmGain[1].v.toFixed(4)), Number((0.42 * 0.2).toFixed(4)));
    });
    phrase.stop();
  }
});

test('playAdminTone preserves default siren and all 5 distinct library sounds cleanly', () => {
  const actxDefault = createMockAudioContext(5);
  const defPhrase = playAdminTone(actxDefault, 'default');
  assert.ok(defPhrase.repeatMs < 3000);
  assert.equal(actxDefault.oscillators.length, 2);
  assert.ok(actxDefault.oscillators.every((o) => o.type === 'square'));
  assert.deepEqual(
    actxDefault.oscillators.flatMap((o) => o.frequency.events.map((e) => e.v)),
    [1050, 700]
  );
  defPhrase.stop();
  assert.ok(actxDefault.oscillators.every((o) => o.stoppedCalls >= 1));

  const signatures = new Set();
  for (const sound of ALARM_SOUNDS) {
    const actxCustom = createMockAudioContext(5);
    const phrase = playAdminTone(actxCustom, sound.id);
    assert.equal(phrase.repeatMs, sound.repeatMs);
    assert.ok(actxCustom.oscillators.length >= 2);
    const sig = actxCustom.oscillators.map((o) => ({
      type: o.type,
      start: Number((o.startedAt - 5).toFixed(3)),
      dur: Number((o.stoppedAt - o.startedAt).toFixed(3)),
      freqs: o.frequency.events.map((e) => Number(e.v.toFixed(2))),
    }));
    signatures.add(JSON.stringify(sig));
    phrase.stop();
  }
  assert.equal(signatures.size, 5, 'Admin library must preserve 5 distinct sounds');
});
