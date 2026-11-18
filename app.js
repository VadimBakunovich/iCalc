'use strict';

/* =========================================================
   iCalc — рецепты, запасы и список покупок в упаковках.
   Все данные хранятся локально на устройстве (localStorage).
   ========================================================= */

const KEY = 'icalc.v1';
const EPS = 1e-6;
const UNITS = [
  { v: 'г', name: 'граммы (г)' },
  { v: 'мл', name: 'миллилитры (мл)' },
  { v: 'шт', name: 'штуки (шт)' },
];

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n * 100) / 100) : '—');
const inVal = (n) => (n === '' || n == null || !Number.isFinite(+n) ? '' : String(+(+n).toFixed(4)).replace('.', ','));
const collator = new Intl.Collator('ru');
const byName = (a, b) => collator.compare(a.name, b.name);
const cur = () => state.settings.currency || '₽';
const money = (n) => `${fmt(n)} ${esc(cur())}`;
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ---------- state ----------
function blank() {
  return { v: 1, ingredients: [], recipes: [], plan: [], checked: {}, settings: { currency: '₽' } };
}
function normalize(s) {
  const b = blank();
  return {
    ...b,
    ...s,
    ingredients: Array.isArray(s.ingredients) ? s.ingredients : [],
    recipes: Array.isArray(s.recipes) ? s.recipes : [],
    plan: Array.isArray(s.plan) ? s.plan : [],
    checked: s.checked && typeof s.checked === 'object' ? s.checked : {},
    settings: { ...b.settings, ...(s.settings || {}) },
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.ingredients)) return normalize(s);
  } catch (e) { /* ignore */ }
  return blank();
}
let state = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    toast('Не удалось сохранить данные!');
  }
}
const getIng = (id) => state.ingredients.find((i) => i.id === id);
const getRec = (id) => state.recipes.find((r) => r.id === id);

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function openSheet(html) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  $('#sheets').appendChild(wrap);
  document.body.classList.add('noscroll');
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  $$('[data-close]', wrap).forEach((b) => (b.onclick = () => closeSheet(wrap)));
  return wrap;
}
function closeSheet(wrap) {
  if (document.activeElement) document.activeElement.blur();
  wrap.classList.remove('open');
  setTimeout(() => {
    wrap.remove();
    if (!$('#sheets').children.length) document.body.classList.remove('noscroll');
  }, 280);
}

function empty(emoji, title, text, btnLabel, action) {
  return `<div class="empty"><div class="emoji">${emoji}</div><h2>${title}</h2><p>${text}</p>
    ${btnLabel ? `<button class="btn inline" data-action="${action}">${btnLabel}</button>` : ''}</div>`;
}

// ---------- tabs ----------
const TABS = {
  plan: { title: 'План', render: renderPlan, action: ['+ Рецепт', () => pickRecipesForPlan()] },
  recipes: { title: 'Рецепты', render: renderRecipes, action: ['+ Новый', () => editRecipe()] },
  ingredients: { title: 'Ингредиенты', render: renderIngredients, action: ['+ Новый', () => editIngredient()] },
  more: { title: 'Ещё', render: renderMore },
};
let tab = 'plan';
try { tab = sessionStorage.getItem('icalc.tab') || 'plan'; } catch (e) { /* ignore */ }
if (!TABS[tab]) tab = 'plan';
let ingSearch = '';

function setTab(t) {
  tab = t;
  try { sessionStorage.setItem('icalc.tab', t); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const t = TABS[tab];
  $('#title').textContent = t.title;
  const b = $('#topAction');
  const showAction = t.action && !(tab === 'plan' && !state.recipes.length);
  b.hidden = !showAction;
  if (showAction) {
    b.textContent = t.action[0];
    b.onclick = t.action[1];
  }
  $('#view').innerHTML = t.render();
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  if (tab === 'ingredients') applyIngSearch();
}

/* =========================================================
   Ингредиенты
   ========================================================= */
function packText(i) {
  return i.packSize > 0 ? `${esc(i.packName || 'упаковка')} ${fmt(i.packSize)} ${i.unit}` : '<span class="warn">размер упаковки не указан</span>';
}

function renderIngredients() {
  if (!state.ingredients.length) {
    return empty('🧈', 'Пока нет ингредиентов',
      'Добавьте муку, сахар, яйца… Для каждого укажите, в каких упаковках он продаётся и сколько его уже есть дома.',
      'Добавить ингредиент', 'new-ing');
  }
  const list = [...state.ingredients].sort(byName);
  return `<div class="search"><input type="search" id="ingSearch" placeholder="Поиск" value="${esc(ingSearch)}" autocomplete="off"></div>
    <ul class="list">${list.map((i) => `
      <li class="row tap" data-action="edit-ing" data-id="${i.id}" data-name="${esc(i.name.toLowerCase())}">
        <div class="row-main">
          <div class="row-title">${esc(i.name)}</div>
          <div class="row-sub">${packText(i)}${i.price > 0 ? ` · ${money(i.price)}` : ''}</div>
        </div>
        <div class="row-side ${i.stock > EPS ? '' : 'zero'}">
          <div class="big">${fmt(i.stock || 0)} ${i.unit}</div>
          <div class="small">дома</div>
        </div>
      </li>`).join('')}</ul>
    <p class="muted small-text" style="margin:12px 4px">Нажмите на ингредиент, чтобы изменить упаковку или запас дома.</p>`;
}

function applyIngSearch() {
  const q = ingSearch.trim().toLowerCase();
  $$('#view [data-name]').forEach((li) => (li.hidden = q && !li.dataset.name.includes(q)));
}

function editIngredient(id, onSaved) {
  const i = id ? getIng(id) : null;
  const d = i ? { ...i } : { name: '', unit: 'г', packSize: '', packName: '', price: '', stock: '' };
  const el = openSheet(`
    <div class="sheet-head">
      <button type="button" data-close>Отмена</button>
      <h2>${i ? 'Ингредиент' : 'Новый ингредиент'}</h2>
      <button type="button" class="primary" data-save>Готово</button>
    </div>
    <div class="sheet-body">
      <label class="field"><span>Название</span>
        <input name="name" value="${esc(d.name)}" placeholder="Например, Мука пшеничная" autocomplete="off"></label>
      <label class="field"><span>Единица измерения</span>
        <select name="unit">${UNITS.map((u) => `<option value="${u.v}" ${u.v === d.unit ? 'selected' : ''}>${u.name}</option>`).join('')}</select>
        <div class="note">В этих единицах указывается количество в рецептах и запас дома.</div></label>

      <div class="group-title">Упаковка в магазине</div>
      <div class="grid2">
        <label class="field"><span>Сколько в упаковке, <b class="u">${d.unit}</b></span>
          <input name="packSize" inputmode="decimal" value="${inVal(d.packSize || '')}" placeholder="1000" autocomplete="off"></label>
        <label class="field"><span>Как называется</span>
          <input name="packName" value="${esc(d.packName)}" placeholder="пачка" autocomplete="off"></label>
      </div>
      <label class="field"><span>Цена за упаковку, ${esc(cur())} — необязательно</span>
        <input name="price" inputmode="decimal" value="${inVal(d.price || '')}" placeholder="0" autocomplete="off"></label>

      <div class="group-title">Запас дома</div>
      <label class="field"><span>Сейчас дома, <b class="u">${d.unit}</b></span>
        <div class="with-btn">
          <input name="stock" inputmode="decimal" value="${inVal(d.stock)}" placeholder="0" autocomplete="off">
          <button type="button" data-addpack>+1 уп.</button>
        </div></label>

      ${i ? '<div class="btn-stack"><button type="button" class="btn danger" data-delete>Удалить ингредиент</button></div>' : ''}
    </div>`);

  const f = (n) => $(`[name="${n}"]`, el);
  if (!i) setTimeout(() => f('name').focus(), 300);
  f('unit').onchange = () => $$('.u', el).forEach((u) => (u.textContent = f('unit').value));
  $('[data-addpack]', el).onclick = () => {
    const ps = num(f('packSize').value);
    if (!(ps > 0)) return toast('Сначала укажите размер упаковки');
    const st = num(f('stock').value);
    f('stock').value = inVal((Number.isFinite(st) ? st : 0) + ps);
  };
  $('[data-save]', el).onclick = () => {
    const name = f('name').value.trim();
    if (!name) { f('name').focus(); return toast('Введите название'); }
    const dup = state.ingredients.find((x) => x.id !== id && x.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) return toast('Ингредиент с таким названием уже есть');
    const packSize = num(f('packSize').value), price = num(f('price').value), stock = num(f('stock').value);
    const obj = {
      id: i ? i.id : uid(),
      name,
      unit: f('unit').value,
      packSize: packSize > 0 ? packSize : 0,
      packName: f('packName').value.trim(),
      price: price > 0 ? price : 0,
      stock: stock > 0 ? stock : 0,
    };
    if (i) Object.assign(i, obj); else state.ingredients.push(obj);
    save();
    closeSheet(el);
    render();
    if (onSaved) onSaved(obj);
  };
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    const used = state.recipes.filter((r) => r.items.some((x) => x.ingId === id));
    const msg = used.length
      ? `«${i.name}» используется в рецептах: ${used.map((r) => r.name).join(', ')}.\n\nУдалить ингредиент и убрать его из этих рецептов?`
      : `Удалить «${i.name}»?`;
    if (!confirm(msg)) return;
    used.forEach((r) => (r.items = r.items.filter((x) => x.ingId !== id)));
    state.ingredients = state.ingredients.filter((x) => x.id !== id);
    delete state.checked[id];
    save();
    closeSheet(el);
    render();
    toast('Ингредиент удалён');
  };
}

/* =========================================================
   Рецепты
   ========================================================= */
function renderRecipes() {
  if (!state.recipes.length) {
    return empty('📖', 'Пока нет рецептов',
      'Рецепт — это список ингредиентов на одну партию: один торт, противень печенья и т.п.',
      'Добавить рецепт', 'new-rec');
  }
  const inPlan = new Map(state.plan.map((p) => [p.recipeId, p.count]));
  return `<ul class="list">${[...state.recipes].sort(byName).map((r) => {
    const n = r.items.length;
    const c = inPlan.get(r.id);
    return `<li class="row tap" data-action="edit-rec" data-id="${r.id}">
      <div class="row-main">
        <div class="row-title">${esc(r.name)}</div>
        <div class="row-sub">${n} ${plural(n, 'ингредиент', 'ингредиента', 'ингредиентов')}${r.note ? ' · ' + esc(r.note) : ''}</div>
      </div>
      ${c ? `<span class="badge" title="в плане">${fmt(c)}</span>` : ''}
      <button type="button" class="chip-btn" data-action="add-to-plan" data-id="${r.id}">+ в план</button>
    </li>`;
  }).join('')}</ul>`;
}

function editRecipe(id, copyFrom) {
  const r = id ? getRec(id) : null;
  const src = r || copyFrom;
  const d = src
    ? { name: copyFrom ? `${src.name} (копия)` : src.name, note: src.note || '', items: src.items.map((x) => ({ ...x })) }
    : { name: '', note: '', items: [] };
  if (!d.items.length) d.items.push({ ingId: '', qty: '' });

  const el = openSheet(`
    <div class="sheet-head">
      <button type="button" data-close>Отмена</button>
      <h2>${r ? 'Рецепт' : 'Новый рецепт'}</h2>
      <button type="button" class="primary" data-save>Готово</button>
    </div>
    <div class="sheet-body">
      <label class="field"><span>Название</span>
        <input name="name" value="${esc(d.name)}" placeholder="Например, Медовик" autocomplete="off"></label>
      <label class="field"><span>Заметка — необязательно</span>
        <input name="note" value="${esc(d.note)}" placeholder="Выход: 1 торт, форма 22 см" autocomplete="off"></label>
      <div class="group-title">Ингредиенты на одну партию</div>
      <div class="rec-rows"></div>
      <button type="button" class="add-row" data-addrow>＋ Добавить ингредиент</button>
      ${r ? `<div class="btn-stack">
        <button type="button" class="btn plain" data-copy>Сделать копию рецепта</button>
        <button type="button" class="btn danger" data-delete>Удалить рецепт</button>
      </div>` : ''}
    </div>`);

  const rowsEl = $('.rec-rows', el);
  const drawRows = () => {
    const opts = [...state.ingredients].sort(byName);
    rowsEl.innerHTML = d.items.map((it, k) => {
      const g = getIng(it.ingId);
      return `<div class="rec-row" data-k="${k}">
        <select data-f="ingId" aria-label="Ингредиент">
          <option value="">— выберите —</option>
          ${opts.map((o) => `<option value="${o.id}" ${o.id === it.ingId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          <option value="__new">＋ Новый ингредиент…</option>
        </select>
        <input data-f="qty" inputmode="decimal" placeholder="0" value="${inVal(it.qty)}" aria-label="Количество" autocomplete="off">
        <span class="unit">${g ? g.unit : ''}</span>
        <button type="button" class="del" data-delrow aria-label="Убрать">✕</button>
      </div>`;
    }).join('');
  };
  drawRows();
  if (!src) setTimeout(() => $('[name="name"]', el).focus(), 300);

  rowsEl.addEventListener('change', (e) => {
    const row = e.target.closest('.rec-row');
    if (!row || e.target.dataset.f !== 'ingId') return;
    const it = d.items[+row.dataset.k];
    if (e.target.value === '__new') {
      e.target.value = it.ingId;
      editIngredient(null, (ni) => { it.ingId = ni.id; drawRows(); });
      return;
    }
    it.ingId = e.target.value;
    const g = getIng(it.ingId);
    $('.unit', row).textContent = g ? g.unit : '';
    if (g) $('[data-f="qty"]', row).focus();
  });
  rowsEl.addEventListener('input', (e) => {
    const row = e.target.closest('.rec-row');
    if (row && e.target.dataset.f === 'qty') d.items[+row.dataset.k].qty = e.target.value;
  });
  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-delrow]');
    if (!b) return;
    d.items.splice(+b.closest('.rec-row').dataset.k, 1);
    if (!d.items.length) d.items.push({ ingId: '', qty: '' });
    drawRows();
  });
  $('[data-addrow]', el).onclick = () => {
    d.items.push({ ingId: '', qty: '' });
    drawRows();
    $$('.rec-row select', rowsEl).pop().focus();
  };

  $('[data-save]', el).onclick = () => {
    const name = $('[name="name"]', el).value.trim();
    if (!name) { $('[name="name"]', el).focus(); return toast('Введите название рецепта'); }
    const merged = new Map();
    for (const it of d.items) {
      if (!it.ingId) continue;
      const q = num(it.qty);
      if (!(q > 0)) return toast(`Укажите количество: ${getIng(it.ingId)?.name || ''}`);
      merged.set(it.ingId, (merged.get(it.ingId) || 0) + q);
    }
    if (!merged.size) return toast('Добавьте хотя бы один ингредиент');
    const obj = {
      id: r ? r.id : uid(),
      name,
      note: $('[name="note"]', el).value.trim(),
      items: [...merged].map(([ingId, qty]) => ({ ingId, qty })),
    };
    if (r) Object.assign(r, obj); else state.recipes.push(obj);
    save();
    closeSheet(el);
    render();
    toast(r ? 'Рецепт сохранён' : 'Рецепт добавлен');
  };

  const copyBtn = $('[data-copy]', el);
  if (copyBtn) copyBtn.onclick = () => { closeSheet(el); setTimeout(() => editRecipe(null, r), 300); };
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    if (!confirm(`Удалить рецепт «${r.name}»?`)) return;
    state.recipes = state.recipes.filter((x) => x.id !== r.id);
    state.plan = state.plan.filter((p) => p.recipeId !== r.id);
    save();
    closeSheet(el);
    render();
    toast('Рецепт удалён');
  };
}

/* =========================================================
   План и список покупок
   ========================================================= */
function addToPlan(recipeId, delta = 1) {
  const p = state.plan.find((x) => x.recipeId === recipeId);
  if (p) p.count = Math.round((p.count + delta) * 100) / 100;
  else if (delta > 0) state.plan.push({ recipeId, count: delta });
  state.plan = state.plan.filter((x) => x.count > EPS);
  save();
}

function pickRecipesForPlan() {
  const el = openSheet(`
    <div class="sheet-head">
      <span></span><h2>Добавить в план</h2>
      <button type="button" class="primary" data-close>Готово</button>
    </div>
    <div class="sheet-body">
      <p class="muted small-text" style="margin:4px 4px 12px">Нажмите на рецепт столько раз, сколько партий нужно испечь.</p>
      <ul class="list pick-list"></ul>
    </div>`);
  const ul = $('.pick-list', el);
  const draw = () => {
    const inPlan = new Map(state.plan.map((p) => [p.recipeId, p.count]));
    ul.innerHTML = [...state.recipes].sort(byName).map((r) => `
      <li class="row" data-id="${r.id}">
        <div class="row-main"><div class="row-title">${esc(r.name)}</div>${r.note ? `<div class="row-sub">${esc(r.note)}</div>` : ''}</div>
        ${inPlan.get(r.id) ? `<span class="badge">${fmt(inPlan.get(r.id))}</span>` : '<span class="chip-btn">+ 1</span>'}
      </li>`).join('');
  };
  draw();
  ul.onclick = (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    addToPlan(li.dataset.id, 1);
    draw();
    render();
  };
}

function calc() {
  const need = new Map();
  for (const p of state.plan) {
    const r = getRec(p.recipeId);
    if (!r) continue;
    for (const it of r.items) need.set(it.ingId, (need.get(it.ingId) || 0) + it.qty * p.count);
  }
  const rows = [];
  for (const [id, n] of need) {
    const ing = getIng(id);
    if (!ing) continue;
    const stock = ing.stock || 0;
    const deficit = Math.max(0, n - stock);
    const ps = ing.packSize > 0 ? ing.packSize : 0;
    let packs = 0, buyAmount = 0;
    if (deficit > EPS) {
      if (ps) { packs = Math.ceil(deficit / ps - 1e-9); buyAmount = packs * ps; }
      else buyAmount = deficit;
    }
    rows.push({
      ing, need: n, stock, deficit, packs, buyAmount,
      leftover: stock + buyAmount - n,
      cost: ing.price > 0 && packs ? packs * ing.price : 0,
    });
  }
  rows.sort((a, b) => byName(a.ing, b.ing));
  return rows;
}

function buyLabel(r) {
  const u = r.ing.unit;
  if (r.packs) return `${r.packs} × ${esc(r.ing.packName || 'уп.')} <small>по ${fmt(r.ing.packSize)} ${u}</small>`;
  return `${fmt(r.buyAmount)} ${u}`;
}

function renderPlan() {
  if (!state.recipes.length) {
    return empty('🎂', 'Добро пожаловать в iCalc!',
      'Чтобы посчитать покупки: 1) добавьте ингредиенты с размером упаковок и запасом дома, 2) добавьте рецепты, 3) соберите здесь план выпечки.',
      state.ingredients.length ? 'Добавить рецепт' : 'Добавить ингредиенты',
      state.ingredients.length ? 'goto-recipes' : 'goto-ingredients');
  }

  let html = '<div class="section-title"><span>Что печём</span></div>';
  const plan = state.plan.filter((p) => getRec(p.recipeId));
  if (!plan.length) {
    return html + `<div class="hint">План пуст. Нажмите «+ Рецепт» вверху и выберите, что и сколько партий нужно испечь — здесь появится список покупок.</div>`;
  }
  html += `<ul class="list">${plan.map((p) => {
    const r = getRec(p.recipeId);
    return `<li class="row">
      <div class="row-main"><div class="row-title">${esc(r.name)}</div>
        <div class="row-sub">${r.note ? esc(r.note) + ' · ' : ''}партий:</div></div>
      <div class="stepper">
        <button type="button" data-action="plan-dec" data-id="${r.id}" aria-label="Меньше">−</button>
        <input data-plan-count data-id="${r.id}" inputmode="decimal" value="${inVal(p.count)}" aria-label="Партий">
        <button type="button" data-action="plan-inc" data-id="${r.id}" aria-label="Больше">+</button>
      </div>
    </li>`;
  }).join('')}</ul>`;

  const rows = calc();
  const buy = rows.filter((r) => r.deficit > EPS);
  const enough = rows.filter((r) => r.deficit <= EPS);
  const total = buy.reduce((s, r) => s + r.cost, 0);
  const noPrice = buy.some((r) => !r.cost && r.packs);

  html += `<div class="section-title"><span>Купить в магазине</span><span>${buy.length ? buy.length + ' поз.' : ''}</span></div>`;
  if (!buy.length) {
    html += `<div class="all-good">✓ Всего хватает дома — ничего покупать не нужно</div>`;
  } else {
    html += `<ul class="list">${buy.map((r) => {
      const checked = !!state.checked[r.ing.id];
      return `<li class="row tap buy-row ${checked ? 'checked' : ''}" data-action="toggle-check" data-id="${r.ing.id}">
        <span class="check"></span>
        <div class="row-main">
          <div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub">нужно ${fmt(r.need)} ${r.ing.unit} · дома ${fmt(r.stock)}${r.ing.packSize > 0 ? ` · останется ${fmt(r.leftover)}` : ''}</div>
          ${r.ing.packSize > 0 ? '' : '<div class="row-sub warn">Размер упаковки не указан — показано точное количество</div>'}
        </div>
        <div class="row-side">
          <div class="packs">${buyLabel(r)}</div>
          ${r.cost ? `<div class="cost">${money(r.cost)}</div>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
    if (total > 0) {
      html += `<div class="total"><span>Примерно${noPrice ? '*' : ''}</span><span>${money(total)}</span></div>`;
      if (noPrice) html += `<p class="muted small-text" style="margin:6px 4px">* не у всех ингредиентов указана цена</p>`;
    }
  }

  if (enough.length) {
    html += `<details class="enough"><summary>Хватает дома (${enough.length}) ›</summary>
      <ul class="list">${enough.map((r) => `
        <li class="row"><div class="row-main"><div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub">нужно ${fmt(r.need)} ${r.ing.unit} из ${fmt(r.stock)} · останется ${fmt(r.leftover)}</div></div></li>`).join('')}
      </ul></details>`;
  }

  html += `<div class="btn-stack">
    ${buy.length ? '<button type="button" class="btn secondary" data-action="share-list">Отправить список</button>' : ''}
    ${buy.length ? '<button type="button" class="btn" data-action="bought">Купила — добавить в запасы</button>' : ''}
    <button type="button" class="btn plain" data-action="baked">Испекла — списать из запасов</button>
    <button type="button" class="btn danger" data-action="clear-plan">Очистить план</button>
  </div>`;
  return html;
}

function shoppingText() {
  const rows = calc().filter((r) => r.deficit > EPS);
  const plan = state.plan.map((p) => getRec(p.recipeId) && `${getRec(p.recipeId).name} × ${fmt(p.count)}`).filter(Boolean);
  const lines = rows.map((r) => {
    const what = r.packs
      ? `${r.packs} × ${r.ing.packName || 'уп.'} по ${fmt(r.ing.packSize)} ${r.ing.unit}`
      : `${fmt(r.buyAmount)} ${r.ing.unit}`;
    return `• ${r.ing.name} — ${what}`;
  });
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return `🛒 Купить:\n${lines.join('\n')}${total > 0 ? `\n\nПримерно: ${fmt(total)} ${cur()}` : ''}\n\nПлан: ${plan.join(', ')}`;
}

async function shareList() {
  const text = shoppingText();
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try { await navigator.clipboard.writeText(text); toast('Список скопирован'); }
  catch (e) { prompt('Скопируйте список:', text); }
}

function markBought() {
  const buy = calc().filter((r) => r.deficit > EPS);
  const someChecked = buy.some((r) => state.checked[r.ing.id]);
  const items = someChecked ? buy.filter((r) => state.checked[r.ing.id]) : buy;
  const msg = someChecked
    ? `Добавить в запасы дома отмеченные позиции (${items.length} из ${buy.length})?`
    : `Добавить в запасы дома всё из списка покупок (${items.length} поз.)?`;
  if (!confirm(msg)) return;
  items.forEach((r) => {
    r.ing.stock = Math.round(((r.ing.stock || 0) + r.buyAmount) * 1000) / 1000;
    delete state.checked[r.ing.id];
  });
  save();
  render();
  toast('Запасы обновлены');
}

function markBaked() {
  const rows = calc();
  const short = rows.filter((r) => r.deficit > EPS);
  let msg = 'Списать из запасов все ингредиенты по этому плану? План будет очищен.';
  if (short.length) msg += `\n\nВнимание: дома не хватает: ${short.map((r) => r.ing.name).join(', ')}. Их запас станет 0.`;
  if (!confirm(msg)) return;
  rows.forEach((r) => (r.ing.stock = Math.max(0, Math.round((r.stock - r.need) * 1000) / 1000)));
  state.plan = [];
  state.checked = {};
  save();
  render();
  toast('Ингредиенты списаны');
}

/* =========================================================
   Ещё: настройки и резервная копия
   ========================================================= */
function renderMore() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `
    <div class="section-title"><span>Резервная копия</span></div>
    <div class="card">
      <p class="small-text muted">Все данные хранятся только на этом телефоне. Время от времени сохраняйте копию (например, в «Файлы» или себе в мессенджер) — пригодится при смене телефона.</p>
      <div class="btn-stack">
        <button type="button" class="btn secondary" data-action="export">Сохранить копию</button>
        <button type="button" class="btn plain" data-action="import">Восстановить из копии</button>
      </div>
    </div>

    <div class="section-title"><span>Настройки</span></div>
    <div class="card">
      <label class="field" style="margin:0"><span>Валюта</span>
        <input id="currency" value="${esc(cur())}" maxlength="5" autocomplete="off"></label>
    </div>

    ${standalone ? '' : `
    <div class="section-title"><span>Установка на iPhone</span></div>
    <div class="card small-text"><ol>
      <li>Откройте эту страницу в Safari.</li>
      <li>Нажмите «Поделиться» (квадрат со стрелкой).</li>
      <li>Выберите «На экран “Домой”».</li>
    </ol><p class="muted" style="margin-top:8px">После этого iCalc работает как обычное приложение, в том числе без интернета.</p></div>`}

    <div class="section-title"><span>Данные</span></div>
    <div class="card small-text muted">
      Ингредиентов: ${state.ingredients.length} · Рецептов: ${state.recipes.length}
    </div>
    <div class="btn-stack">
      <button type="button" class="btn plain" data-action="demo">Загрузить пример данных</button>
      <button type="button" class="btn danger" data-action="reset">Удалить все данные</button>
    </div>
    <p class="muted small-text" style="text-align:center;margin-top:24px">iCalc · версия 1.0</p>`;
}

async function exportData() {
  const json = JSON.stringify(state, null, 2);
  const d = new Date();
  const name = `icalc-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Копия iCalc' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s || !Array.isArray(s.ingredients) || !Array.isArray(s.recipes)) throw new Error('bad');
      if (!confirm(`В копии: ингредиентов ${s.ingredients.length}, рецептов ${s.recipes.length}.\n\nЗаменить текущие данные?`)) return;
      state = normalize(s);
      save();
      render();
      toast('Данные восстановлены');
    } catch (e) {
      alert('Не удалось прочитать файл. Это точно копия из iCalc?');
    }
  };
  input.click();
}

function loadDemo() {
  if ((state.ingredients.length || state.recipes.length) && !confirm('Заменить текущие данные примером?')) return;
  const I = (name, unit, packSize, packName, price, stock) => ({ id: uid(), name, unit, packSize, packName, price, stock });
  const ings = {
    flour: I('Мука пшеничная', 'г', 2000, 'пакет', 120, 1500),
    sugar: I('Сахар', 'г', 1000, 'пачка', 90, 800),
    butter: I('Масло сливочное 82%', 'г', 180, 'пачка', 210, 360),
    eggs: I('Яйца С0', 'шт', 10, 'лоток', 130, 6),
    cream: I('Сливки 33%', 'мл', 500, 'пакет', 320, 0),
    cheese: I('Сыр творожный', 'г', 500, 'банка', 450, 0),
    honey: I('Мёд', 'г', 500, 'банка', 380, 200),
    soda: I('Сода', 'г', 500, 'пачка', 50, 400),
    choc: I('Шоколад тёмный', 'г', 100, 'плитка', 140, 0),
  };
  const R = (name, note, items) => ({ id: uid(), name, note, items: items.map(([k, qty]) => ({ ingId: ings[k].id, qty })) });
  state = normalize({
    ingredients: Object.values(ings),
    recipes: [
      R('Медовик', '1 торт, форма 22 см', [['flour', 500], ['sugar', 250], ['butter', 100], ['eggs', 3], ['honey', 100], ['soda', 5], ['cream', 600], ['cheese', 500]]),
      R('Шоколадное печенье', '24 шт', [['flour', 280], ['sugar', 200], ['butter', 170], ['eggs', 2], ['choc', 200], ['soda', 5]]),
    ],
    plan: [],
    settings: state.settings,
  });
  save();
  setTab('plan');
  toast('Пример загружен');
}

function resetAll() {
  if (!confirm('Удалить ВСЕ рецепты, ингредиенты и план? Это нельзя отменить.')) return;
  if (!confirm('Точно удалить? Рекомендуем сначала сохранить копию.')) return;
  state = blank();
  save();
  render();
  toast('Все данные удалены');
}

/* =========================================================
   События
   ========================================================= */
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.tabbar [data-tab]');
  if (tabBtn) return setTab(tabBtn.dataset.tab);

  const a = e.target.closest('#view [data-action]');
  if (!a) return;
  const id = a.dataset.id;
  switch (a.dataset.action) {
    case 'new-ing': return editIngredient();
    case 'edit-ing': return editIngredient(id);
    case 'new-rec': return editRecipe();
    case 'edit-rec': return editRecipe(id);
    case 'goto-recipes': return setTab('recipes');
    case 'goto-ingredients': return setTab('ingredients');
    case 'add-to-plan':
      addToPlan(id, 1);
      render();
      return toast(`«${getRec(id).name}» в плане: ${fmt(state.plan.find((p) => p.recipeId === id).count)}`);
    case 'plan-inc': addToPlan(id, 1); return render();
    case 'plan-dec': {
      const p = state.plan.find((x) => x.recipeId === id);
      if (p && p.count <= 1 + EPS && !confirm(`Убрать «${getRec(id).name}» из плана?`)) return;
      addToPlan(id, p && p.count < 1 ? -p.count : -1);
      return render();
    }
    case 'toggle-check':
      if (state.checked[id]) delete state.checked[id]; else state.checked[id] = true;
      save();
      return a.classList.toggle('checked', !!state.checked[id]);
    case 'share-list': return shareList();
    case 'bought': return markBought();
    case 'baked': return markBaked();
    case 'clear-plan':
      if (!confirm('Очистить план выпечки?')) return;
      state.plan = []; state.checked = {}; save(); return render();
    case 'export': return exportData();
    case 'import': return importData();
    case 'demo': return loadDemo();
    case 'reset': return resetAll();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ingSearch') { ingSearch = e.target.value; applyIngSearch(); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('#view [data-plan-count]')) {
    const p = state.plan.find((x) => x.recipeId === t.dataset.id);
    const v = num(t.value);
    if (!p) return;
    if (!Number.isFinite(v) || v < 0) { t.value = inVal(p.count); return toast('Введите число'); }
    if (v <= EPS) state.plan = state.plan.filter((x) => x !== p);
    else p.count = Math.round(v * 100) / 100;
    save();
    render();
  }
  if (t.id === 'currency') {
    state.settings.currency = t.value.trim() || '₽';
    save();
    toast('Валюта сохранена');
  }
});

// ---------- start ----------
render();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Просим браузер не удалять данные автоматически.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
