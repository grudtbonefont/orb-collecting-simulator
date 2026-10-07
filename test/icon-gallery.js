// Test-only: builds a gallery of every catalog item icon inside a loaded game page (used by test/screenshot.js).
module.exports = () => {
  const cats = [{ key: 'color', name: 'Цвета' }, { key: 'shape', name: 'Формы' }, { key: 'trail', name: 'Следы' }, { key: 'nameColor', name: 'Цвет ника' }, { key: 'hat', name: 'Шапки' }, { key: 'misc', name: 'Прочее' }];
  const root = document.createElement('div');
  root.id = 'iconGallery';
  Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#070b18', padding: '18px 24px', overflow: 'auto', fontFamily: 'Segoe UI, system-ui, sans-serif', color: '#e8ecff' });
  const h = document.createElement('h2'); h.textContent = 'Иконки всех предметов'; h.style.margin = '0 0 10px'; root.appendChild(h);
  for (const c of cats) {
    const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '8px' });
    const lab = document.createElement('div'); lab.textContent = c.name; Object.assign(lab.style, { width: '96px', paddingTop: '36px', color: '#8a93b8', fontWeight: '700', fontSize: '14px' });
    row.appendChild(lab);
    for (const it of G.ITEMS.filter(i => i.cat === c.key)) {
      const cell = document.createElement('div'); Object.assign(cell.style, { width: '112px', textAlign: 'center', fontSize: '12px' });
      const box = document.createElement('div'); box.className = 'ico'; box.style.setProperty('--rc', G.RARITIES[it.rarity].color); box.style.margin = '0 auto 4px';
      const img = document.createElement('img'); img.src = window.OCSIcons.url(it.id); img.alt = it.name; box.appendChild(img);
      const nm = document.createElement('div'); nm.textContent = it.name + (it.price === 0 ? ' (базовый)' : ''); nm.style.fontWeight = '600';
      const rr = document.createElement('div'); rr.textContent = G.RARITIES[it.rarity].name; rr.style.color = G.RARITIES[it.rarity].color;
      cell.append(box, nm, rr); row.appendChild(cell);
    }
    root.appendChild(row);
  }
  document.body.appendChild(root);
};
