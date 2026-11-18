'use strict';

/* =========================================================
   iCalc — рецепты, запасы и список покупок в упаковках.
   Все данные хранятся локально на устройстве (localStorage).
   Тексты интерфейса — в i18n.js.
   ========================================================= */

const KEY = 'icalc.v1';
const EPS = 1e-6;
const VERSION = '1.3';
// Внутренние коды единиц (хранятся в данных); подписи — из перевода.
const UNIT_CODES = ['г', 'мл', 'шт'];

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
const inVal = (n) => (n === '' || n == null || !Number.isFinite(+n) ? '' : String(+(+n).toFixed(4)).replace('.', ','));

// ---------- language ----------
function detectLang() {
  const l = (navigator.language || '').toLowerCase();
  return l.startsWith('pl') ? 'pl' : 'ru';
}
let nf, collator;
function lang() { return LANGS[state.settings.lang] ? state.settings.lang : 'ru'; }
function applyLocale() {
  const loc = LANGS[lang()].locale;
  nf = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  collator = new Intl.Collator(loc);
  document.documentElement.lang = lang();
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
}
function t(key, vars) {
  let s = I18N[lang()][key] ?? I18N.ru[key] ?? key;
  if (typeof s === 'function') return s(vars);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}
const U = (code) => t('unit_' + code);
const fmt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n * 100) / 100) : '—');
const byName = (a, b) => collator.compare(a.name, b.name);
const cur = () => state.settings.currency || 'zł';
const money = (n) => `${fmt(n)} ${esc(cur())}`;

// ---------- state ----------
function blank() {
  return { v: 1, ingredients: [], recipes: [], plan: [], checked: {}, settings: { currency: 'zł', lang: detectLang() } };
}
function normalize(s) {
  const b = blank();
  // Ранние версии по умолчанию ставили рубли — переводим на злотые.
  if (s.settings && s.settings.currency === '₽') s.settings.currency = 'zł';
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
    toast(t('save_failed'));
  }
}
const getIng = (id) => state.ingredients.find((i) => i.id === id);
const getRec = (id) => state.recipes.find((r) => r.id === id);

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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
  plan: { title: 'tab_plan', render: renderPlan, action: ['add_recipe_btn', () => pickRecipesForPlan()] },
  recipes: { title: 'tab_recipes', render: renderRecipes, action: ['new_btn', () => editRecipe()] },
  ingredients: { title: 'tab_ingredients', render: renderIngredients, action: ['new_btn', () => editIngredient()] },
  more: { title: 'tab_more', render: renderMore },
};
let tab = 'plan';
try { tab = sessionStorage.getItem('icalc.tab') || 'plan'; } catch (e) { /* ignore */ }
if (!TABS[tab]) tab = 'plan';
let ingSearch = '';

function setTab(name) {
  tab = name;
  try { sessionStorage.setItem('icalc.tab', name); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const tb = TABS[tab];
  $('#title').textContent = t(tb.title);
  const b = $('#topAction');
  const showAction = tb.action && !(tab === 'plan' && !state.recipes.length);
  b.hidden = !showAction;
  if (showAction) {
    b.textContent = t(tb.action[0]);
    b.onclick = tb.action[1];
  }
  $('#view').innerHTML = tb.render();
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  if (tab === 'ingredients') applyIngSearch();
}

/* =========================================================
   Ингредиенты
   ========================================================= */
function packText(i) {
  return i.packSize > 0
    ? `${esc(i.packName || t('pack_default'))} ${fmt(i.packSize)} ${U(i.unit)}`
    : `<span class="warn">${t('pack_missing')}</span>`;
}

function renderIngredients() {
  if (!state.ingredients.length) {
    return empty('🧈', t('ing_empty_title'), t('ing_empty_text'), t('ing_empty_btn'), 'new-ing');
  }
  const list = [...state.ingredients].sort(byName);
  return `<div class="search"><input type="search" id="ingSearch" placeholder="${t('search')}" value="${esc(ingSearch)}" autocomplete="off"></div>
    <ul class="list">${list.map((i) => `
      <li class="row tap" data-action="edit-ing" data-id="${i.id}" data-name="${esc(i.name.toLowerCase())}">
        <div class="row-main">
          <div class="row-title">${esc(i.name)}</div>
          <div class="row-sub">${packText(i)}${i.price > 0 ? ` · ${money(i.price)}` : ''}</div>
        </div>
        <div class="row-side ${i.stock > EPS ? '' : 'zero'}">
          <div class="big">${fmt(i.stock || 0)} ${U(i.unit)}</div>
          <div class="small">${t('at_home')}</div>
        </div>
      </li>`).join('')}</ul>
    <p class="muted small-text" style="margin:12px 4px">${t('ing_list_hint')}</p>`;
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
      <button type="button" data-close>${t('cancel')}</button>
      <h2>${i ? t('ing_title') : t('ing_new_title')}</h2>
      <button type="button" class="primary" data-save>${t('done')}</button>
    </div>
    <div class="sheet-body">
      <label class="field"><span>${t('name')}</span>
        <input name="name" value="${esc(d.name)}" placeholder="${t('ing_name_ph')}" autocomplete="off"></label>
      <label class="field"><span>${t('unit')}</span>
        <select name="unit">${UNIT_CODES.map((u) => `<option value="${u}" ${u === d.unit ? 'selected' : ''}>${t('unitname_' + u)}</option>`).join('')}</select>
        <div class="note">${t('unit_note')}</div></label>

      <div class="group-title">${t('pack_group')}</div>
      <div class="grid2">
        <label class="field"><span>${t('pack_size')}, <b class="u">${U(d.unit)}</b></span>
          <input name="packSize" inputmode="decimal" value="${inVal(d.packSize || '')}" placeholder="1000" autocomplete="off"></label>
        <label class="field"><span>${t('pack_name')}</span>
          <input name="packName" value="${esc(d.packName)}" placeholder="${t('pack_name_ph')}" autocomplete="off"></label>
      </div>
      <label class="field"><span>${t('price', { cur: esc(cur()) })}</span>
        <input name="price" inputmode="decimal" value="${inVal(d.price || '')}" placeholder="0" autocomplete="off"></label>

      <div class="group-title">${t('stock_group')}</div>
      <label class="field"><span>${t('stock_now')}, <b class="u">${U(d.unit)}</b></span>
        <div class="with-btn">
          <input name="stock" inputmode="decimal" value="${inVal(d.stock)}" placeholder="0" autocomplete="off">
          <button type="button" data-addpack>${t('add_pack')}</button>
        </div></label>

      ${i ? `<div class="btn-stack"><button type="button" class="btn danger" data-delete>${t('delete_ing')}</button></div>` : ''}
    </div>`);

  const f = (n) => $(`[name="${n}"]`, el);
  if (!i) setTimeout(() => f('name').focus(), 300);
  f('unit').onchange = () => $$('.u', el).forEach((u) => (u.textContent = U(f('unit').value)));
  $('[data-addpack]', el).onclick = () => {
    const ps = num(f('packSize').value);
    if (!(ps > 0)) return toast(t('need_pack_first'));
    const st = num(f('stock').value);
    f('stock').value = inVal((Number.isFinite(st) ? st : 0) + ps);
  };
  $('[data-save]', el).onclick = () => {
    const name = f('name').value.trim();
    if (!name) { f('name').focus(); return toast(t('enter_name')); }
    const dup = state.ingredients.find((x) => x.id !== id && x.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) return toast(t('dup_ing'));
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
      ? t('ing_used_confirm', { name: i.name, list: used.map((r) => r.name).join(', ') })
      : t('ing_delete_confirm', { name: i.name });
    if (!confirm(msg)) return;
    used.forEach((r) => (r.items = r.items.filter((x) => x.ingId !== id)));
    state.ingredients = state.ingredients.filter((x) => x.id !== id);
    delete state.checked[id];
    save();
    closeSheet(el);
    render();
    toast(t('ing_deleted'));
  };
}

/* =========================================================
   Рецепты
   ========================================================= */
function renderRecipes() {
  if (!state.recipes.length) {
    return empty('📖', t('rec_empty_title'), t('rec_empty_text'), t('rec_empty_btn'), 'new-rec');
  }
  const inPlan = new Map(state.plan.map((p) => [p.recipeId, p.count]));
  return `<ul class="list">${[...state.recipes].sort(byName).map((r) => {
    const c = inPlan.get(r.id);
    return `<li class="row tap" data-action="edit-rec" data-id="${r.id}">
      <div class="row-main">
        <div class="row-title">${esc(r.name)}</div>
        <div class="row-sub">${t('n_ingredients', r.items.length)}${r.note ? ' · ' + esc(r.note) : ''}</div>
      </div>
      ${c ? `<span class="badge" title="${t('in_plan')}">${fmt(c)}</span>` : ''}
      <button type="button" class="chip-btn" data-action="add-to-plan" data-id="${r.id}">${t('to_plan')}</button>
    </li>`;
  }).join('')}</ul>`;
}

function editRecipe(id, copyFrom) {
  const r = id ? getRec(id) : null;
  const src = r || copyFrom;
  const d = src
    ? { name: copyFrom ? `${src.name} ${t('copy_suffix')}` : src.name, note: src.note || '', items: src.items.map((x) => ({ ...x })) }
    : { name: '', note: '', items: [] };
  if (!d.items.length) d.items.push({ ingId: '', qty: '' });

  const el = openSheet(`
    <div class="sheet-head">
      <button type="button" data-close>${t('cancel')}</button>
      <h2>${r ? t('rec_title') : t('rec_new_title')}</h2>
      <button type="button" class="primary" data-save>${t('done')}</button>
    </div>
    <div class="sheet-body">
      <label class="field"><span>${t('name')}</span>
        <input name="name" value="${esc(d.name)}" placeholder="${t('rec_name_ph')}" autocomplete="off"></label>
      <label class="field"><span>${t('note')}</span>
        <input name="note" value="${esc(d.note)}" placeholder="${t('note_ph')}" autocomplete="off"></label>
      <div class="group-title">${t('rec_ings_group')}</div>
      <div class="rec-rows"></div>
      <button type="button" class="add-row" data-addrow>${t('add_ing_row')}</button>
      ${r ? `<div class="btn-stack">
        <button type="button" class="btn plain" data-copy>${t('copy_recipe')}</button>
        <button type="button" class="btn danger" data-delete>${t('delete_recipe')}</button>
      </div>` : ''}
    </div>`);

  const rowsEl = $('.rec-rows', el);
  const drawRows = () => {
    const opts = [...state.ingredients].sort(byName);
    rowsEl.innerHTML = d.items.map((it, k) => {
      const g = getIng(it.ingId);
      return `<div class="rec-row" data-k="${k}">
        <select data-f="ingId" aria-label="${t('ing_title')}">
          <option value="">${t('choose')}</option>
          ${opts.map((o) => `<option value="${o.id}" ${o.id === it.ingId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          <option value="__new">${t('new_ing_option')}</option>
        </select>
        <input data-f="qty" inputmode="decimal" placeholder="0" value="${inVal(it.qty)}" aria-label="${t('qty')}" autocomplete="off">
        <span class="unit">${g ? U(g.unit) : ''}</span>
        <button type="button" class="del" data-delrow aria-label="${t('remove')}">✕</button>
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
    $('.unit', row).textContent = g ? U(g.unit) : '';
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
    if (!name) { $('[name="name"]', el).focus(); return toast(t('enter_rec_name')); }
    const merged = new Map();
    for (const it of d.items) {
      if (!it.ingId) continue;
      const q = num(it.qty);
      if (!(q > 0)) return toast(t('enter_qty', { name: getIng(it.ingId)?.name || '' }));
      merged.set(it.ingId, (merged.get(it.ingId) || 0) + q);
    }
    if (!merged.size) return toast(t('need_one_ing'));
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
    toast(r ? t('rec_saved') : t('rec_added'));
  };

  const copyBtn = $('[data-copy]', el);
  if (copyBtn) copyBtn.onclick = () => { closeSheet(el); setTimeout(() => editRecipe(null, r), 300); };
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    if (!confirm(t('rec_delete_confirm', { name: r.name }))) return;
    state.recipes = state.recipes.filter((x) => x.id !== r.id);
    state.plan = state.plan.filter((p) => p.recipeId !== r.id);
    save();
    closeSheet(el);
    render();
    toast(t('rec_deleted'));
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
      <span></span><h2>${t('pick_title')}</h2>
      <button type="button" class="primary" data-close>${t('done')}</button>
    </div>
    <div class="sheet-body">
      <p class="muted small-text" style="margin:4px 4px 12px">${t('pick_hint')}</p>
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
  const u = U(r.ing.unit);
  if (r.packs) return `${r.packs} × ${esc(r.ing.packName || t('pack_short'))} <small>${t('each')} ${fmt(r.ing.packSize)} ${u}</small>`;
  return `${fmt(r.buyAmount)} ${u}`;
}

function renderPlan() {
  if (!state.recipes.length) {
    return empty('🎂', t('welcome_title'), t('welcome_text'),
      state.ingredients.length ? t('rec_empty_btn') : t('add_ings_btn'),
      state.ingredients.length ? 'goto-recipes' : 'goto-ingredients');
  }

  let html = `<div class="section-title"><span>${t('what_we_bake')}</span></div>`;
  const plan = state.plan.filter((p) => getRec(p.recipeId));
  if (!plan.length) return html + `<div class="hint">${t('plan_empty')}</div>`;

  html += `<ul class="list">${plan.map((p) => {
    const r = getRec(p.recipeId);
    return `<li class="row">
      <div class="row-main"><div class="row-title">${esc(r.name)}</div>
        <div class="row-sub">${r.note ? esc(r.note) + ' · ' : ''}${t('batches')}</div></div>
      <div class="stepper">
        <button type="button" data-action="plan-dec" data-id="${r.id}" aria-label="${t('less')}">−</button>
        <input data-plan-count data-id="${r.id}" inputmode="decimal" value="${inVal(p.count)}" aria-label="${t('batches')}">
        <button type="button" data-action="plan-inc" data-id="${r.id}" aria-label="${t('more')}">+</button>
      </div>
    </li>`;
  }).join('')}</ul>`;

  const rows = calc();
  const buy = rows.filter((r) => r.deficit > EPS);
  const enough = rows.filter((r) => r.deficit <= EPS);
  const total = buy.reduce((s, r) => s + r.cost, 0);
  const noPrice = buy.some((r) => !r.cost && r.packs);

  html += `<div class="section-title"><span>${t('buy_title')}</span><span>${buy.length ? t('positions', { n: buy.length }) : ''}</span></div>`;
  if (!buy.length) {
    html += `<div class="all-good">${t('all_good')}</div>`;
  } else {
    html += `<ul class="list">${buy.map((r) => {
      const checked = !!state.checked[r.ing.id];
      const u = U(r.ing.unit);
      return `<li class="row tap buy-row ${checked ? 'checked' : ''}" data-action="toggle-check" data-id="${r.ing.id}">
        <span class="check"></span>
        <div class="row-main">
          <div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub">${t('need')} ${fmt(r.need)} ${u} · ${t('home')} ${fmt(r.stock)}${r.ing.packSize > 0 ? ` · ${t('left')} ${fmt(r.leftover)}` : ''}</div>
          ${r.ing.packSize > 0 ? '' : `<div class="row-sub warn">${t('no_pack_warn')}</div>`}
        </div>
        <div class="row-side">
          <div class="packs">${buyLabel(r)}</div>
          ${r.cost ? `<div class="cost">${money(r.cost)}</div>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
    if (total > 0) {
      html += `<div class="total"><span>${t('approx')}${noPrice ? '*' : ''}</span><span>${money(total)}</span></div>`;
      if (noPrice) html += `<p class="muted small-text" style="margin:6px 4px">${t('no_price_note')}</p>`;
    }
  }

  if (enough.length) {
    html += `<details class="enough"><summary>${t('enough', { n: enough.length })}</summary>
      <ul class="list">${enough.map((r) => `
        <li class="row"><div class="row-main"><div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub">${t('need')} ${fmt(r.need)} ${U(r.ing.unit)} ${t('of')} ${fmt(r.stock)} · ${t('left')} ${fmt(r.leftover)}</div></div></li>`).join('')}
      </ul></details>`;
  }

  html += `<div class="btn-stack">
    ${buy.length ? `<button type="button" class="btn secondary" data-action="share-list">${t('share_list')}</button>` : ''}
    ${buy.length ? `<button type="button" class="btn" data-action="bought">${t('bought')}</button>` : ''}
    <button type="button" class="btn plain" data-action="baked">${t('baked')}</button>
    <button type="button" class="btn danger" data-action="clear-plan">${t('clear_plan')}</button>
  </div>`;
  return html;
}

function shoppingText() {
  const rows = calc().filter((r) => r.deficit > EPS);
  const plan = state.plan.map((p) => getRec(p.recipeId) && `${getRec(p.recipeId).name} × ${fmt(p.count)}`).filter(Boolean);
  const lines = rows.map((r) => {
    const u = U(r.ing.unit);
    const what = r.packs
      ? `${r.packs} × ${r.ing.packName || t('pack_short')} ${t('each')} ${fmt(r.ing.packSize)} ${u}`
      : `${fmt(r.buyAmount)} ${u}`;
    return `• ${r.ing.name} — ${what}`;
  });
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return `${t('share_header')}\n${lines.join('\n')}${total > 0 ? `\n\n${t('approx')}: ${fmt(total)} ${cur()}` : ''}\n\n${t('share_plan')} ${plan.join(', ')}`;
}

async function shareList() {
  const text = shoppingText();
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try { await navigator.clipboard.writeText(text); toast(t('copied')); }
  catch (e) { prompt(t('copy_prompt'), text); }
}

function markBought() {
  const buy = calc().filter((r) => r.deficit > EPS);
  const someChecked = buy.some((r) => state.checked[r.ing.id]);
  const items = someChecked ? buy.filter((r) => state.checked[r.ing.id]) : buy;
  const msg = someChecked
    ? t('bought_checked_confirm', { n: items.length, total: buy.length })
    : t('bought_all_confirm', { n: items.length });
  if (!confirm(msg)) return;
  items.forEach((r) => {
    r.ing.stock = Math.round(((r.ing.stock || 0) + r.buyAmount) * 1000) / 1000;
    delete state.checked[r.ing.id];
  });
  save();
  render();
  toast(t('stock_updated'));
}

function markBaked() {
  const rows = calc();
  const short = rows.filter((r) => r.deficit > EPS);
  let msg = t('baked_confirm');
  if (short.length) msg += t('baked_short', { list: short.map((r) => r.ing.name).join(', ') });
  if (!confirm(msg)) return;
  rows.forEach((r) => (r.ing.stock = Math.max(0, Math.round((r.stock - r.need) * 1000) / 1000)));
  state.plan = [];
  state.checked = {};
  save();
  render();
  toast(t('baked_done'));
}

/* =========================================================
   Ещё: настройки и резервная копия
   ========================================================= */
function renderMore() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `
    <div class="section-title"><span>${t('settings')}</span></div>
    <div class="card">
      <div class="field"><span>${t('language')}</span>
        <div class="segmented">${Object.entries(LANGS).map(([code, l]) =>
          `<button type="button" data-action="set-lang" data-lang="${code}" class="${code === lang() ? 'active' : ''}">${l.name}</button>`).join('')}
        </div></div>
      <label class="field" style="margin:0"><span>${t('currency')}</span>
        <input id="currency" value="${esc(cur())}" maxlength="5" autocomplete="off"></label>
    </div>

    <div class="section-title"><span>${t('backup')}</span></div>
    <div class="card">
      <p class="small-text muted">${t('backup_text')}</p>
      <div class="btn-stack">
        <button type="button" class="btn secondary" data-action="export">${t('export')}</button>
        <button type="button" class="btn plain" data-action="import">${t('import')}</button>
      </div>
    </div>

    ${standalone ? '' : `
    <div class="section-title"><span>${t('install')}</span></div>
    <div class="card small-text"><ol>
      <li>${t('install_1')}</li>
      <li>${t('install_2')}</li>
      <li>${t('install_3')}</li>
    </ol><p class="muted" style="margin-top:8px">${t('install_note')}</p></div>`}

    <div class="section-title"><span>${t('data')}</span></div>
    <div class="card small-text muted">${t('data_counts', { i: state.ingredients.length, r: state.recipes.length })}</div>
    <div class="btn-stack">
      <button type="button" class="btn plain" data-action="demo">${t('demo')}</button>
      <button type="button" class="btn danger" data-action="reset">${t('reset')}</button>
    </div>
    <p class="muted small-text" style="text-align:center;margin-top:24px">${t('version', { v: VERSION })}</p>`;
}

function setLang(code) {
  if (!LANGS[code]) return;
  state.settings.lang = code;
  save();
  applyLocale();
  render();
}

async function exportData() {
  const json = JSON.stringify(state, null, 2);
  const d = new Date();
  const name = `icalc-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: t('backup_title') });
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
      if (!confirm(t('import_confirm', { i: s.ingredients.length, r: s.recipes.length }))) return;
      const keepLang = state.settings.lang;
      state = normalize(s);
      if (!s.settings || !s.settings.lang) state.settings.lang = keepLang;
      save();
      applyLocale();
      render();
      toast(t('restored'));
    } catch (e) {
      alert(t('import_failed'));
    }
  };
  input.click();
}

function loadDemo() {
  if ((state.ingredients.length || state.recipes.length) && !confirm(t('demo_confirm'))) return;
  const D = t('demo_data');
  const I = (k, unit, packSize, price, stock) => ({ id: uid(), name: D[k][0], unit, packSize, packName: D[k][1], price, stock });
  const ings = {
    flour: I('flour', 'г', 1000, 4, 1500),
    sugar: I('sugar', 'г', 1000, 4.5, 800),
    butter: I('butter', 'г', 200, 7.5, 400),
    eggs: I('eggs', 'шт', 10, 11, 6),
    cream: I('cream', 'мл', 500, 12, 0),
    cheese: I('cheese', 'г', 250, 9, 0),
    honey: I('honey', 'г', 400, 22, 200),
    soda: I('soda', 'г', 70, 1.5, 60),
    choc: I('choc', 'г', 100, 6, 0),
  };
  const R = (k, items) => ({ id: uid(), name: D[k][0], note: D[k][1], items: items.map(([ik, qty]) => ({ ingId: ings[ik].id, qty })) });
  state = normalize({
    ingredients: Object.values(ings),
    recipes: [
      R('r1', [['flour', 500], ['sugar', 250], ['butter', 100], ['eggs', 3], ['honey', 100], ['soda', 5], ['cream', 600], ['cheese', 500]]),
      R('r2', [['flour', 280], ['sugar', 200], ['butter', 170], ['eggs', 2], ['choc', 200], ['soda', 5]]),
    ],
    plan: [],
    settings: state.settings,
  });
  save();
  setTab('plan');
  toast(t('demo_loaded'));
}

function resetAll() {
  if (!confirm(t('reset_confirm1'))) return;
  if (!confirm(t('reset_confirm2'))) return;
  const settings = state.settings;
  state = blank();
  state.settings = settings;
  save();
  render();
  toast(t('reset_done'));
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
      return toast(t('added_to_plan', { name: getRec(id).name, n: fmt(state.plan.find((p) => p.recipeId === id).count) }));
    case 'plan-inc': addToPlan(id, 1); return render();
    case 'plan-dec': {
      const p = state.plan.find((x) => x.recipeId === id);
      if (p && p.count <= 1 + EPS && !confirm(t('remove_from_plan', { name: getRec(id).name }))) return;
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
      if (!confirm(t('clear_plan_confirm'))) return;
      state.plan = []; state.checked = {}; save(); return render();
    case 'set-lang': return setLang(a.dataset.lang);
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
  const el = e.target;
  if (el.matches('#view [data-plan-count]')) {
    const p = state.plan.find((x) => x.recipeId === el.dataset.id);
    const v = num(el.value);
    if (!p) return;
    if (!Number.isFinite(v) || v < 0) { el.value = inVal(p.count); return toast(t('enter_number')); }
    if (v <= EPS) state.plan = state.plan.filter((x) => x !== p);
    else p.count = Math.round(v * 100) / 100;
    save();
    render();
  }
  if (el.id === 'currency') {
    state.settings.currency = el.value.trim() || 'zł';
    save();
    toast(t('currency_saved'));
  }
});

// ---------- start ----------
applyLocale();
render();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Когда установилась новая версия — перезагружаемся, если ничего не редактируется.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !$('#sheets').children.length) location.reload();
  });
}
// Просим браузер не удалять данные автоматически.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
