import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.resolve(process.cwd(), 'public');
const MARKER_WRAPPER_RE = /\.(?:ops-marker|dash-cap-pin|dash-merch-pin|leaflet-marker-icon|leaflet-div-icon)\b/;

/** Walk top-level and @media CSS rule blocks and return { selector, body } pairs. */
function collectCssRules(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (src) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open === -1) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const inner = src.slice(open + 1, j - 1);
      if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
        walk(inner);
      } else if (!prelude.startsWith('@')) {
        rules.push({ selector: prelude, body: inner });
      }
      i = j;
    }
  };
  walk(clean);
  return rules;
}

/** Split selector list carefully outside :is(...) / (...) parens. */
function splitSelectors(selectorText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start).trim());
  return parts.filter(Boolean);
}

/** True when a single selector directly targets the marker wrapper itself (not a descendant like `.ops-marker .ops-pin-core`). */
function targetsMarkerWrapperDirectly(singleSelector) {
  const lastSegment = singleSelector.trim().split(/[\s>+~]+/).pop() || '';
  return MARKER_WRAPPER_RE.test(lastSegment);
}

test('CSS regression: all L.divIcon marker classes keep position: absolute and never transition transform', () => {
  const cssFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith('.css'));
  assert.ok(cssFiles.includes('admin.css'), 'admin.css exists');

  const seenAbsolute = new Set();

  for (const file of cssFiles) {
    const css = fs.readFileSync(path.join(publicDir, file), 'utf8');
    for (const rule of collectCssRules(css)) {
      const selectors = splitSelectors(rule.selector);
      const hitsWrapper = selectors.some(targetsMarkerWrapperDirectly);
      if (!hitsWrapper) continue;

      const decls = rule.body.split(';').map((s) => s.trim()).filter(Boolean);
      for (const d of decls) {
        const colon = d.indexOf(':');
        if (colon <= 0) continue;
        const prop = d.slice(0, colon).trim().toLowerCase();
        const val = d.slice(colon + 1).trim().toLowerCase();
        if (prop === 'position') {
          assert.equal(
            val,
            'absolute',
            `${file} rule "${rule.selector}" sets position: ${val} on a Leaflet marker wrapper (must be absolute)`
          );
          for (const cls of ['ops-marker', 'dash-cap-pin', 'dash-merch-pin']) {
            if (selectors.some((s) => targetsMarkerWrapperDirectly(s) && s.includes(`.${cls}`))) {
              seenAbsolute.add(cls);
            }
          }
        }
        if (prop === 'transition') {
          assert.equal(
            /\btransform\b/.test(val),
            false,
            `${file} rule "${rule.selector}" must not transition transform on a Leaflet marker wrapper`
          );
        }
      }
    }
  }

  for (const cls of ['ops-marker', 'dash-cap-pin', 'dash-merch-pin']) {
    assert.ok(seenAbsolute.has(cls), `.${cls} must explicitly set position: absolute in CSS`);
  }

  const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  assert.ok(adminHtml.includes('/admin.css?v=panther2026v30'), 'admin.html busts cache with /admin.css?v=panther2026v30');
});
