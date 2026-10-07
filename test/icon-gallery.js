// Test-only: builds a gallery of every catalog item icon (plus upgrade icons) inside a loaded game page (used by test/screenshot.js).
module.exports = () => {
  const cats = [{ key: 'color', name: 'Цвета' }, { key: 'shape', name: 'Формы' }, { key: 'trail', name: 'Следы' }, { key: 'nameColor', name: 'Цвет ника' }, { key: 'hat', name: 'Шапки' }, { key: 'misc', name: 'Прочее' }, { key: 'upgrades', name: 'Улучшения' }];
  const root = document.createElement('div');
  root.id = 'iconGallery';
  Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#070b18', padding: '14px 20px', overflow: 'auto', fontFamily: 'Segoe UI, system-ui, sans-serif', color: '#e8ecff' });
  const h = document.createElement('h2'); h.textContent = `Иконки всех предметов (${G.ITEMS.length}) и улучшений (${G.UPGRADE_KEYS.length})`; h.style.margin = '0 0 8px'; root.appendChild(h);
  const fmt = n => Number(n).toLocaleString('ru-RU');
  for (const c of cats) {
    const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' });
    const lab = document.createElement('div'); lab.textContent = c.name; Object.assign(lab.style, { width: '84px', flex: 'none', paddingTop: '26px', color: '#8a93b8', fontWeight: '700', fontSize: '13px' });
    const cells = document.createElement('div'); Object.assign(cells.style, { display: 'flex', flexWrap: 'wrap', gap: '6px 4px' });
    row.append(lab, cells);
    const list = c.key === 'upgrades'
      ? G.UPGRADE_KEYS.map(k => ({ id: 'u_' + k, name: G.UPGRADES[k].name, rarity: ['mult', 'luck'].includes(k) ? 'epic' : 'rare', sub: `${G.UPGRADES[k].max} ур.` }))
      : G.ITEMS.filter(i => i.cat === c.key);
    for (const it of list) {
      const cell = document.createElement('div'); Object.assign(cell.style, { width: '98px', textAlign: 'center', fontSize: '11px', lineHeight: '1.2' });
      const box = document.createElement('div'); box.className = 'ico'; box.style.setProperty('--rc', G.RARITIES[it.rarity].color);
      Object.assign(box.style, { margin: '0 auto 3px', width: '72px', height: '72px', borderRadius: '14px' });
      const img = document.createElement('img'); img.src = window.OCSIcons.url(it.id); img.alt = it.name; box.appendChild(img);
      const nm = document.createElement('div'); nm.textContent = it.name; nm.style.fontWeight = '600';
      const rr = document.createElement('div'); rr.style.color = G.RARITIES[it.rarity].color;
      rr.textContent = it.sub || (it.price === 0 ? 'базовый' : it.price ? `${G.RARITIES[it.rarity].name} · ${fmt(it.price)}` : G.RARITIES[it.rarity].name);
      cell.append(box, nm, rr); cells.appendChild(cell);
    }
    root.appendChild(row);
  }
  document.body.appendChild(root);
};
