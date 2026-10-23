// Hand-made potion sprites (own art): one SVG per potion kind, 128×128 viewBox, rasterized once by client.js.
(function () {
  const OUT = '#1d1433';
  const K = {
    speed: { liq: '#2aa8ff', lite: '#8fe0ff', dark: '#1352c9', glow: '#4cc3ff' },
    orbs: { liq: '#ffa01e', lite: '#ffe27a', dark: '#d4560c', glow: '#ffb84a' },
    luck: { liq: '#36cc5e', lite: '#b4f57a', dark: '#137a3c', glow: '#5be37f' },
    magnet: { liq: '#ff4f8a', lite: '#ffa8c8', dark: '#b8195a', glow: '#ff6fa0' },
    shard: { liq: '#9645ff', lite: '#dcb6ff', dark: '#4c17b8', glow: '#b072ff' },
  };
  // body path, neck [x0,x1,y0,y1], liquid level, emblem [cx,cy,r], highlight path, shadow rx
  const S = {
    speed: { body: 'M45 40 H83 V94 A19 19 0 0 1 45 94 Z', neck: [51, 77, 30, 42], lv: 58, em: [66, 84, 13], hl: 'M54 48 C52 62 52 80 54 98', sh: 22 },
    orbs: { body: 'M44 46 H84 Q100 46 100 62 V98 Q100 114 84 114 H44 Q28 114 28 98 V62 Q28 46 44 46 Z', neck: [47, 81, 32, 48], lv: 66, em: [64, 88, 15], hl: 'M37 62 C35 74 35 88 37 100', sh: 40 },
    luck: { body: 'M56 50 A34 34 0 1 0 72 50 Z', neck: [55, 73, 28, 52], lv: 70, em: [64, 86, 14], hl: 'M41 70 C38 82 42 96 50 104', sh: 34 },
    magnet: { body: 'M64 60 C78 40 110 48 107 74 C105 94 82 105 64 117 C46 105 23 94 21 74 C18 48 50 40 64 60 Z', neck: [55, 73, 30, 58], lv: 70, em: [64, 84, 13], hl: 'M31 66 C28 76 32 88 40 94', sh: 36 },
    shard: { body: 'M44 50 H84 L110 76 L92 112 H36 L18 76 Z', neck: [55, 73, 30, 52], lv: 72, em: [64, 88, 14], hl: 'M30 76 L40 98', sh: 42 },
  };
  const emblem = (k, cx, cy, r, c) => {
    const s = r / 14, T = (d) => `<g transform="translate(${cx} ${cy}) scale(${s})">${d}</g>`;
    const badge = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff8ea" stroke="${OUT}" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="${r - 3.5}" fill="none" stroke="${c.liq}" stroke-width="1.6" stroke-dasharray="2 2.4" opacity=".8"/>`;
    const ic = {
      speed: T(`<path d="M3 -11 L-6 2 H0 L-3 11 L7 -3 H1 Z" fill="#ffd23a" stroke="${OUT}" stroke-width="2.2" stroke-linejoin="round"/>`),
      orbs: T(`<circle r="8.5" fill="#ffc72e" stroke="${OUT}" stroke-width="2.2"/><circle r="5.2" fill="none" stroke="#e38a00" stroke-width="1.6"/><path d="M-2 -6 C-4.5 -4 -4.5 0 -2 1" stroke="#fff6c8" stroke-width="1.6" fill="none" stroke-linecap="round"/>`),
      luck: T(`<g fill="#3fc561" stroke="${OUT}" stroke-width="1.8"><circle cx="-4" cy="-4" r="4.6"/><circle cx="4" cy="-4" r="4.6"/><circle cx="-4" cy="4" r="4.6"/><circle cx="4" cy="4" r="4.6"/></g><path d="M1 3 Q4 8 8 11" stroke="${OUT}" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle r="2" fill="#a8f08a"/>`),
      magnet: T(`<path d="M-7 -8 V1 A7 7 0 0 0 7 1 V-8" fill="none" stroke="${OUT}" stroke-width="7.5" stroke-linecap="butt"/><path d="M-7 -8 V1 A7 7 0 0 0 7 1 V-8" fill="none" stroke="#ff3b5c" stroke-width="4"/><path d="M-9 -9 H-5 M5 -9 H9" stroke="#d9e2ee" stroke-width="4"/><rect x="-9.8" y="-11.5" width="5.6" height="5" fill="#dfe6f0" stroke="${OUT}" stroke-width="1.6"/><rect x="4.2" y="-11.5" width="5.6" height="5" fill="#dfe6f0" stroke="${OUT}" stroke-width="1.6"/>`),
      shard: T(`<path d="M0 -11 L8 -3 L0 11 L-8 -3 Z" fill="#c993ff" stroke="${OUT}" stroke-width="2.2" stroke-linejoin="round"/><path d="M-8 -3 H8 M0 -11 L-3 -3 L0 11 M0 -11 L3 -3" stroke="${OUT}" stroke-width="1" fill="none" opacity=".55"/><path d="M-1 -8 L-5 -3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`),
    }[k];
    return badge + ic;
  };
  const cork = (k, n) => {
    const [x0, x1] = n, w = x1 - x0, cx = (x0 + x1) / 2, top = n[2] - 17;
    if (k === 'shard') return `<path d="M${cx} ${top - 9} L${cx + 13} ${top + 5} L${cx + 8} ${n[2] + 2} H${cx - 8} L${cx - 13} ${top + 5} Z" fill="url(#gemS)" stroke="${OUT}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M${cx - 13} ${top + 5} H${cx + 13} M${cx} ${top - 9} L${cx - 5} ${top + 5} L${cx} ${n[2] + 2} M${cx} ${top - 9} L${cx + 5} ${top + 5}" stroke="${OUT}" stroke-width="1.3" opacity=".5" fill="none"/>
      <path d="M${cx - 3} ${top - 1} L${cx - 7} ${top + 5}" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="${x0 - 3}" y="${n[2] - 1}" width="${w + 6}" height="8" rx="3" fill="#ffcf4a" stroke="${OUT}" stroke-width="3"/><rect x="${x0}" y="${n[2] + 1}" width="${w * 0.5}" height="2" rx="1" fill="#fff3b8"/>`;
    const cw = Math.max(w + 2, 24), ch = 21, cxL = cx - cw / 2;
    return `<rect x="${cxL}" y="${top}" width="${cw}" height="${ch}" rx="5" fill="url(#cork)" stroke="${OUT}" stroke-width="3.5"/>
      <path d="M${cxL + 5} ${top + 6} H${cxL + cw * 0.45} M${cxL + cw * 0.55} ${top + 11} H${cxL + cw - 5} M${cxL + 7} ${top + 15} H${cxL + cw * 0.5}" stroke="#8a5328" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>
      <rect x="${cxL + 3}" y="${top + 2.5}" width="${cw * 0.4}" height="3" rx="1.5" fill="#ffe6bf" opacity=".8"/>`;
  };
  function svg(k) {
    const c = K[k], s = S[k], n = s.neck, [nx0, nx1, ny0, ny1] = n, nw = nx1 - nx0;
    const string = k === 'shard' ? '' : `<path d="M${nx0 - 1} ${ny0 + 8} Q64 ${ny0 + 12} ${nx1 + 1} ${ny0 + 8}" stroke="#c0392b" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M${nx1 - 2} ${ny0 + 10} q6 6 2 13 M${nx1 - 2} ${ny0 + 10} q10 2 11 9" stroke="#c0392b" stroke-width="2.6" fill="none" stroke-linecap="round"/><circle cx="${nx1 - 2}" cy="${ny0 + 10}" r="3" fill="#e0533f" stroke="${OUT}" stroke-width="1.5"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="256" height="256">
<defs>
<linearGradient id="liq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.lite}"/><stop offset=".35" stop-color="${c.liq}"/><stop offset="1" stop-color="${c.dark}"/></linearGradient>
<linearGradient id="side" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9fbff" stop-opacity=".75"/><stop offset="1" stop-color="#9fd4ef" stop-opacity=".45"/></linearGradient>
<linearGradient id="cork" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6b07a"/><stop offset="1" stop-color="#b9773f"/></linearGradient>
<linearGradient id="gemS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1dcff"/><stop offset=".5" stop-color="#b273ff"/><stop offset="1" stop-color="#6a2bd9"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${c.glow}" stop-opacity=".55"/><stop offset=".6" stop-color="${c.glow}" stop-opacity=".18"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
<clipPath id="b"><path d="${s.body}"/></clipPath>
</defs>
<circle cx="64" cy="78" r="58" fill="url(#glow)"/>
<rect x="${nx0}" y="${ny0}" width="${nw}" height="${ny1 - ny0 + 6}" fill="url(#glass)"/>
<path d="${s.body}" fill="url(#glass)"/>
<g clip-path="url(#b)">
  <rect x="0" y="${s.lv}" width="128" height="80" fill="url(#liq)"/>
  <ellipse cx="64" cy="122" rx="60" ry="22" fill="${c.dark}" opacity=".45"/>
  <rect x="0" y="0" width="128" height="128" fill="url(#side)"/>
  <ellipse cx="64" cy="${s.lv}" rx="60" ry="5.5" fill="${c.lite}"/>
  <ellipse cx="64" cy="${s.lv - 1.2}" rx="60" ry="4" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/>
  <g fill="#fff" opacity=".75"><circle cx="${64 - 14}" cy="${s.lv + 22}" r="3"/><circle cx="${64 - 8}" cy="${s.lv + 12}" r="1.8"/><circle cx="${64 + 16}" cy="${s.lv + 28}" r="2.4"/><circle cx="${64 + 12}" cy="${s.lv + 14}" r="1.4"/></g>
  <g fill="none" stroke="#fff" stroke-width="1" opacity=".6"><circle cx="${64 - 14}" cy="${s.lv + 22}" r="3"/></g>
  <path d="${s.body}" fill="none" stroke="#fff" stroke-width="6" opacity=".28"/>
</g>
<path d="${s.body}" fill="none" stroke="${OUT}" stroke-width="5" stroke-linejoin="round"/>
<rect x="${nx0}" y="${ny0}" width="${nw}" height="${ny1 - ny0 + 3}" fill="#bfe6f6"/>
<rect x="${nx0 + 3}" y="${ny0 + 2}" width="3" height="${ny1 - ny0}" rx="1.5" fill="#fff" opacity=".8"/>
<rect x="${nx1 - 7}" y="${ny0 + 2}" width="4" height="${ny1 - ny0}" fill="#000" opacity=".1"/>
<path d="M${nx0} ${ny0} V${ny1 + 3} M${nx1} ${ny0} V${ny1 + 3}" stroke="${OUT}" stroke-width="5" stroke-linecap="round"/>
<rect x="${nx0 - 5}" y="${ny0 - 3}" width="${nw + 10}" height="9" rx="4.5" fill="#d9f4ff" stroke="${OUT}" stroke-width="4"/>
<rect x="${nx0 - 2}" y="${ny0 - 1}" width="${nw * 0.55}" height="2.4" rx="1.2" fill="#fff"/>
${string}
${cork(k, n)}
${emblem(k, s.em[0], s.em[1], s.em[2], c)}
<path d="${s.hl}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".9"/>
${(() => { const m = s.hl.match(/M(\d+) (\d+)/); return `<circle cx="${+m[1] + 1}" cy="${+m[2] - 7}" r="2.8" fill="#fff"/>`; })()}
<path d="M98 32 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#fff" opacity=".95"/>
<circle cx="30" cy="40" r="1.8" fill="#fff" opacity=".8"/>
</svg>`;
  }
  const out = {}; for (const k of Object.keys(K)) out[k] = svg(k);
  out.glow = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.glow]));
  if (typeof module !== 'undefined') module.exports = out; else window.OCSPotionArt = out;
})();
