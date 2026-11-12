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
          setValueAtTime(v, t) { freqEvents.push({ v, t }); },
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

test('ALARM_SOUNDS defines 5 distinct short Arabic alarm presets', () => {
  assert.equal(ALARM_SOUNDS.length, 5);
  assert.deepEqual(
    ALARM_SOUNDS.map((s) => s.label),
    ['كلاسيكي', 'سريع', 'عالي', 'نبضة مزدوجة', 'هادئ']
  );
  const ids = ALARM_SOUNDS.map((s) => s.id);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(CAPTAIN_TONES, ids);
  for (const s of ALARM_SOUNDS) {
    assert.ok(s.repeatMs > 0 && s.repeatMs < 3000, `${s.id} cycle ${s.repeatMs}ms must be under 3000ms`);
  }
});

test('normalizeCaptainTone maps legacy values and defaults invalid input cleanly', () => {
  assert.equal(normalizeCaptainTone('classic'), 'classic');
  assert.equal(normalizeCaptainTone('rapid'), 'rapid');
  assert.equal(normalizeCaptainTone('high'), 'high');
  assert.equal(normalizeCaptainTone('pulse'), 'double_pulse');
  assert.equal(normalizeCaptainTone('double_pulse'), 'double_pulse');
  assert.equal(normalizeCaptainTone('soft_bell'), 'calm');
  assert.equal(normalizeCaptainTone('marimba'), 'calm');
  assert.equal(normalizeCaptainTone('chime'), 'calm');
  assert.equal(normalizeCaptainTone('calm'), 'calm');
  assert.ok(CAPTAIN_TONES.includes(normalizeCaptainTone(null)));
  assert.ok(CAPTAIN_TONES.includes(normalizeCaptainTone('unknown_tone')));
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

test('playCaptainTone synthesizes 5 distinct Web Audio patterns under 3 seconds and cleans up on stop()', () => {
  const signatures = new Set();
  for (const sound of ALARM_SOUNDS) {
    const actx = createMockAudioContext(10);
    const phrase = playCaptainTone(actx, sound.id);
    assert.ok(phrase && typeof phrase.stop === 'function');
    assert.ok(phrase.repeatMs > 0 && phrase.repeatMs < 3000);
    assert.ok(actx.oscillators.length >= 1, `${sound.id} must create oscillators`);

    const sig = actx.oscillators.map((o) => ({
      type: o.type,
      start: Number((o.startedAt - 10).toFixed(3)),
      dur: Number((o.stoppedAt - o.startedAt).toFixed(3)),
      freqs: o.frequency.events.map((e) => Number(e.v.toFixed(2))),
    }));
    for (const o of actx.oscillators) {
      assert.ok(o.startedAt >= 10);
      assert.ok(o.stoppedAt > o.startedAt && o.stoppedAt - 10 < 3.0, `${sound.id} exceeds 3s cycle`);
      assert.ok(o.frequency.events.length >= 1);
    }
    signatures.add(JSON.stringify(sig));

    phrase.stop();
    for (const o of actx.oscillators) {
      assert.ok(o.stoppedCalls >= 1);
      assert.equal(o.disconnectedCalls, 1);
    }
    for (const g of actx.gains) {
      assert.equal(g.disconnectedCalls, 1);
    }
  }
  assert.equal(signatures.size, 5, 'All 5 Web Audio sounds must differ in pitch and/or rhythm');
});

test('playAdminTone preserves default siren and delegates library sounds cleanly', () => {
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

  const actxCustom = createMockAudioContext(5);
  const rapidPhrase = playAdminTone(actxCustom, 'rapid');
  assert.equal(rapidPhrase.repeatMs, ALARM_SOUNDS.find((s) => s.id === 'rapid').repeatMs);
  assert.ok(actxCustom.oscillators.length >= 3);
  rapidPhrase.stop();
});
