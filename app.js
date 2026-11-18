'use strict';

/* =========================================================
   iCalc — рецепты, запасы и список покупок в упаковках.
   Все данные хранятся локально на устройстве (localStorage).
   Тексты интерфейса — в i18n.js.
   ========================================================= */

const KEY = 'icalc.v1';
const EPS = 1e-6;
const VERSION = '2.2';
// Базовые единицы ингредиента (хранятся в данных).
const BASE_UNITS = ['г', 'мл', 'шт'];
// Единицы, в которых можно указывать количество в рецепте.
const ITEM_UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'batch'];
// Максимальная вложенность полуфабрикатов — одна и та же для расчёта и проверок.
const MAX_DEPTH = 20;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
// Для поиска: без регистра, «ё» = «е», польские буквы = латинские («maka» найдёт «Mąka»).
const PL_PLAIN = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
const normSearch = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[ąćęłńóśźż]/g, (c) => PL_PLAIN[c]);

/** Строгий разбор числа: «1,5», «1.5», «1 000». Всё остальное — NaN. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return parseFloat(s);
}
/** Число для поля ввода: с запятой, без лишних нулей. Пустое значение остаётся пустым. */
function inVal(n) {
  if (n === '' || n == null) return '';
  const v = +n;
  return Number.isFinite(v) ? String(+v.toFixed(4)).replace('.', ',') : '';
}

class UserError extends Error {}
/** Читает число из поля; при ошибке подсвечивает поле и бросает UserError. */
function readNum(el, { required = false, positive = false, max = Infinity } = {}) {
  el.classList.remove('invalid');
  const raw = el.value.trim();
  const fail = () => {
    el.classList.add('invalid');
    el.focus();
    throw new UserError(t('bad_number'));
  };
  if (!raw) { if (required) fail(); return 0; }
  const v = num(raw);
  if (!Number.isFinite(v) || v < 0 || (positive && v <= 0) || v > max) fail();
  return v;
}
function guarded(fn) {
  return (...a) => {
    try { return fn(...a); } catch (e) {
      if (e instanceof UserError) return toast(e.message);
      throw e;
    }
  };
}

// ---------- language ----------
function detectLang() {
  return (navigator.language || '').toLowerCase().startsWith('pl') ? 'pl' : 'ru';
}
let nf, collator, dfLong, dfShort;
// Язык настраивается отдельно для каждой категории.
const LANG_CATS = ['ui', 'recipes', 'ingredients', 'units', 'packs', 'share'];
const LANG_CODES = Object.keys(LANGS);
function L(cat) {
  const v = state.settings.langs && state.settings.langs[cat];
  return LANGS[v] ? v : 'ru';
}
function lang() { return L('ui'); }
function applyLocale() {
  const loc = LANGS[lang()].locale;
  nf = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  collator = new Intl.Collator(loc);
  dfLong = new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'long' });
  dfShort = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' });
  document.documentElement.lang = lang();
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
}
/** Перевод на заданный язык. */
function tL(lg, key, vars) {
  let s = I18N[lg]?.[key] ?? I18N.ru[key] ?? key;
  if (typeof s === 'function') return s(vars);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}
/** Перевод на язык интерфейса. */
const t = (key, vars) => tL(lang(), key, vars);
/** Единица измерения на языке единиц (или заданном). */
const U = (code, lg = L('units')) => tL(lg, 'unit_' + code);
const fmt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n * 100) / 100) : '—');
const byName = (a, b) => collator.compare(a.name, b.name);

// ---------- двуязычные названия ----------
/** Название на нужном языке; если перевода нет — на другом. */
function pickName(names, lg) {
  if (!names) return '';
  if (names[lg]) return names[lg];
  for (const c of LANG_CODES) if (names[c]) return names[c];
  return '';
}
/** Название объекта (ингредиента, рецепта, упаковки) на заданном языке. */
function nameIn(o, lg) {
  if (o.type && o.type !== 'custom') return tL(lg, 'pack_' + o.type);
  return pickName(o.names, lg);
}
/** Добавляет объекту вычисляемое поле name — на языке своей категории. В файл не сохраняется. */
function bindName(o, cat) {
  Object.defineProperty(o, 'name', { get() { return nameIn(o, L(cat)); }, enumerable: false, configurable: true });
  return o;
}
const bindIng = (i) => { bindName(i, 'ingredients'); i.packs.forEach((p) => bindName(p, 'packs')); return i; };
/** Все названия объекта — для поиска и проверки дублей. */
const allNames = (o) => LANG_CODES.map((c) => (o.names && o.names[c]) || '').filter(Boolean);
const searchKey = (o) => normSearch(allNames(o).join(' '));
const missingLangs = (o) => LANG_CODES.filter((c) => !(o.names && o.names[c]));
/** Есть ли у другого объекта такое же название на любом языке. */
function sameName(list, o, names) {
  const mine = new Set(LANG_CODES.map((c) => normSearch(names[c] || '')).filter(Boolean));
  return list.find((x) => x !== o && allNames(x).some((n) => mine.has(normSearch(n))));
}
/** Перевод названия по словарю: «Сливки 30%» → «Śmietanka 30%». '' — если не знаем. */
function guessName(text, from, to) {
  const src = String(text || '').trim();
  if (!src || from === to) return '';
  const fi = LANG_CODES.indexOf(from), ti = LANG_CODES.indexOf(to);
  const n = normSearch(src);
  let best = null;
  for (const e of GLOSSARY) {
    const k = normSearch(e[fi]);
    if (n === k || (n.startsWith(k + ' ') && !/\p{L}/u.test(src.slice(e[fi].length)))) {
      if (!best || e[fi].length > best[fi].length) best = e;
    }
  }
  return best ? best[ti] + src.slice(best[fi].length) : '';
}
const cur = () => state.settings.currency || 'zł';
const money = (n) => `${fmt(n)} ${esc(cur())}`;
const toDate = (iso) => new Date(iso + 'T00:00:00');
/** Настоящая календарная дата в формате ГГГГ-ММ-ДД (не «2024-13-40»). */
function validDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = toDate(iso);
  if (isNaN(d)) return false;
  const [y, m, day] = iso.split('-').map(Number);
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day;
}
const fmtDate = (iso) => (validDate(iso) ? dfLong.format(toDate(iso)) : '');
const fmtDateShort = (iso) => (validDate(iso) ? dfShort.format(toDate(iso)) : '');

// ---------- state ----------
function blank() {
  return {
    v: 2, ingredients: [], recipes: [], plans: [], activePlan: null, checked: {},
    settings: { currency: 'zł', langs: Object.fromEntries(LANG_CATS.map((c) => [c, detectLang()])), tolerance: 0 },
  };
}

/** Проверяет и чинит данные (из памяти или из файла копии), переводит старый формат в новый. */
function sanitize(s) {
  const out = blank();
  if (!s || typeof s !== 'object') return out;
  const idOk = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x);
  // Отдельные таблицы id для ингредиентов, рецептов и планов: пустые, числовые, повторяющиеся
  // и опасные id получают новые безопасные значения, ссылки переводятся по таблице.
  const ids = () => {
    const map = new Map();
    const used = new Set();
    return {
      def(x) {
        const k = x == null || x === '' ? null : String(x);
        let id = k !== null && !map.has(k) && idOk(k) ? k : uid();
        while (used.has(id)) id = uid();
        used.add(id);
        if (k !== null && !map.has(k)) map.set(k, id);
        return id;
      },
      ref(x) { return x == null || x === '' ? null : map.get(String(x)) || null; },
    };
  };
  const ingIds = ids(), recIdsMap = ids(), planIds = ids();
  const str = (x, max = 200) => (typeof x === 'string' ? x : x == null ? '' : String(x)).slice(0, max).trim();
  const pos = (x) => { const n = +x; return Number.isFinite(n) && n > 0 ? n : 0; };

  const st = s.settings && typeof s.settings === 'object' ? s.settings : {};
  const c = str(st.currency, 5);
  // До версии 2.2 был один язык на всё (settings.lang) — переносим его во все категории.
  const oldLang = LANGS[st.lang] ? st.lang : null;
  const langs = {};
  for (const cat of LANG_CATS) {
    const v = st.langs && st.langs[cat];
    langs[cat] = LANGS[v] ? v : oldLang || out.settings.langs[cat];
  }
  out.settings = { currency: !c || c === '₽' ? 'zł' : c, langs, tolerance: Math.min(100, pos(st.tolerance)) };
  // Старые названия (одно поле name) считаем написанными на тогдашнем языке интерфейса.
  const base = oldLang || langs.ui;

  /** Названия на всех языках. Старое одно название — переводим по словарю, если знаем. */
  const readNames = (o, max) => {
    const n = {};
    if (o.names && typeof o.names === 'object') {
      for (const c of LANG_CODES) { const v = str(o.names[c], max); if (v) n[c] = v; }
    } else {
      const v = str(o.name, max);
      if (v) {
        n[base] = v;
        for (const c of LANG_CODES) if (!n[c]) { const g = guessName(v, base, c); if (g) n[c] = g; }
      }
    }
    return n;
  };
  /** Упаковка: встроенный тип узнаём и по старому текстовому названию на любом языке. */
  const readPack = (p) => {
    let type = PACK_TYPES.includes(p.type) ? p.type : null;
    let names = {};
    if (!type) {
      const raw = p.names && typeof p.names === 'object' ? p.names : { [base]: p.name };
      for (const c of LANG_CODES) { const v = str(raw[c], 40); if (v) names[c] = v; }
      const all = Object.values(names).map(normSearch);
      type = PACK_TYPES.find((tp) => LANG_CODES.some((c) => all.includes(normSearch(tL(c, 'pack_' + tp))))) || 'custom';
      if (type !== 'custom') names = {};
    }
    return { id: idOk(p.id) ? p.id : uid(), size: pos(p.size), price: pos(p.price), type, names };
  };

  for (const i of Array.isArray(s.ingredients) ? s.ingredients : []) {
    if (!i || typeof i !== 'object') continue;
    const names = readNames(i, 100);
    if (!Object.keys(names).length) continue;
    const id = ingIds.def(i.id);
    const rawPacks = Array.isArray(i.packs) ? i.packs
      : pos(i.packSize) ? [{ size: i.packSize, name: i.packName, price: i.price }] : [];
    out.ingredients.push(bindIng({
      id,
      names,
      unit: BASE_UNITS.includes(i.unit) ? i.unit : 'г',
      stock: pos(i.stock),
      packs: rawPacks.filter((p) => p && pos(p.size)).map(readPack),
      pieceWeight: pos(i.pieceWeight),
      store: str(i.store, 40),
      perishable: !!i.perishable,
    }));
  }
  const ingById = new Map(out.ingredients.map((i) => [i.id, i]));

  const rawItems = new Map();
  for (const r of Array.isArray(s.recipes) ? s.recipes : []) {
    if (!r || typeof r !== 'object') continue;
    const names = readNames(r, 100);
    if (!Object.keys(names).length) continue;
    const id = recIdsMap.def(r.id);
    out.recipes.push(bindName({
      id, names, note: str(r.note, 200), isPrep: !!r.isPrep,
      yieldWeight: pos(r.yieldWeight), baseDiameter: pos(r.baseDiameter), loss: Math.min(500, pos(r.loss)), items: [],
    }, 'recipes'));
    rawItems.set(id, Array.isArray(r.items) ? r.items : []);
  }
  for (const r of out.recipes) {
    for (const it of rawItems.get(r.id)) {
      if (!it || typeof it !== 'object' || !pos(it.qty)) continue;
      if (it.recId != null) {
        const recId = recIdsMap.ref(it.recId);
        if (!recId || recId === r.id) continue;
        r.items.push({ recId, qty: pos(it.qty), u: ['batch', 'г', 'кг'].includes(it.u) ? it.u : 'batch' });
      } else {
        const ing = ingById.get(ingIds.ref(it.ingId));
        if (!ing) continue;
        let u = ITEM_UNITS.includes(it.u) ? it.u : ing.unit;
        if (!Number.isFinite(toBase(ing, 1, u))) u = ing.unit;
        r.items.push({ ingId: ing.id, qty: pos(it.qty), u });
      }
    }
  }
  // Убираем циклы полуфабрикатов (A внутри B внутри A).
  const recById = new Map(out.recipes.map((r) => [r.id, r]));
  const reaches = (from, target, depth = 0) => {
    if (from === target) return true;
    if (depth > MAX_DEPTH) return true;
    const r = recById.get(from);
    return !!r && r.items.some((it) => it.recId && reaches(it.recId, target, depth + 1));
  };
  for (const r of out.recipes) r.items = r.items.filter((it) => !it.recId || !reaches(it.recId, r.id));

  const rawPlans = Array.isArray(s.plans) ? s.plans
    : Array.isArray(s.plan) && s.plan.length ? [{ name: '', date: '', items: s.plan }] : [];
  for (const p of rawPlans) {
    if (!p || typeof p !== 'object') continue;
    const items = [];
    for (const it of Array.isArray(p.items) ? p.items : []) {
      if (!it || !pos(it.count)) continue;
      const recipeId = recIdsMap.ref(it.recipeId);
      if (!recipeId || items.some((x) => x.recipeId === recipeId)) continue;
      items.push({ recipeId, count: pos(it.count), diameter: pos(it.diameter) });
    }
    out.plans.push({
      id: planIds.def(p.id),
      name: str(p.name, 60),
      date: validDate(p.date) ? p.date : '',
      items,
    });
  }
  const active = planIds.ref(s.activePlan);
  out.activePlan = s.activePlan === 'all' && out.plans.length > 1 ? 'all'
    : (out.plans.find((p) => p.id === active) || sortPlans(out.plans)[0] || {}).id || null;

  // Отметки «куплено» хранятся отдельно для каждого плана (и для режима «Все»).
  const addChecks = (key, obj) => {
    if (!key || !obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const ingId = ingIds.ref(k);
      if (ingId && obj[k] === true) (out.checked[key] ||= {})[ingId] = true;
    }
  };
  if (s.checked && typeof s.checked === 'object') {
    const flat = Object.values(s.checked).every((v) => typeof v === 'boolean');
    if (flat) addChecks(out.activePlan, s.checked); // формат 1.x/2.0
    else for (const k of Object.keys(s.checked)) addChecks(k === 'all' ? 'all' : planIds.ref(k), s.checked[k]);
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return blank();
}
let state = blank();
state = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    toast(t('save_failed'));
  }
}
const getIng = (id) => state.ingredients.find((i) => i.id === id);
const getRec = (id) => state.recipes.find((r) => r.id === id);
const getPlan = (id) => state.plans.find((p) => p.id === id);
function sortPlans(plans = state.plans) {
  return [...plans].sort((a, b) => (a.date || '9999') .localeCompare(b.date || '9999') || (a.name || '').localeCompare(b.name || ''));
}
const planTitle = (p) => p.name || t('plan_default');
/** Отметки «куплено» текущего плана (или режима «Все»). */
function checks() {
  const key = state.activePlan || '_';
  return (state.checked[key] ||= {});
}
/** Убирает ингредиент из отметок всех планов. */
function uncheckEverywhere(ingId) {
  Object.values(state.checked).forEach((c) => delete c[ingId]);
}

// ---------- units & calculations ----------
function itemUnits(target) {
  if (!target) return [];
  if (target.items) return target.yieldWeight > 0 ? ['batch', 'г', 'кг'] : ['batch'];
  if (target.unit === 'г') return ['г', 'кг'];
  if (target.unit === 'мл') return ['мл', 'л'];
  return target.pieceWeight > 0 ? ['шт', 'г', 'кг'] : ['шт'];
}
/** Переводит количество из единицы рецепта в базовую единицу ингредиента. */
function toBase(ing, qty, u) {
  if (u === ing.unit) return qty;
  if (u === 'кг' && ing.unit === 'г') return qty * 1000;
  if (u === 'л' && ing.unit === 'мл') return qty * 1000;
  if (ing.unit === 'шт' && ing.pieceWeight > 0) {
    if (u === 'г') return qty / ing.pieceWeight;
    if (u === 'кг') return (qty * 1000) / ing.pieceWeight;
  }
  return NaN;
}
/** Сколько партий полуфабриката нужно. */
function subBatches(sub, qty, u) {
  if (u === 'batch') return qty;
  if (sub.yieldWeight > 0 && u === 'г') return qty / sub.yieldWeight;
  if (sub.yieldWeight > 0 && u === 'кг') return (qty * 1000) / sub.yieldWeight;
  return NaN;
}
/** Раскладывает рецепт (с полуфабрикатами и потерями) на ингредиенты. */
function expand(recipe, factor, acc, depth = 0) {
  if (depth > MAX_DEPTH || !(factor > 0)) return acc;
  const k = factor * (1 + (recipe.loss || 0) / 100);
  for (const it of recipe.items) {
    if (it.ingId) {
      const ing = getIng(it.ingId);
      const b = ing ? toBase(ing, it.qty, it.u || ing.unit) : NaN;
      if (Number.isFinite(b)) acc.set(it.ingId, (acc.get(it.ingId) || 0) + k * b);
    } else if (it.recId) {
      const sub = getRec(it.recId);
      const n = sub ? subBatches(sub, it.qty, it.u) : NaN;
      if (Number.isFinite(n)) expand(sub, k * n, acc, depth + 1);
    }
  }
  return acc;
}
function diameterFactor(item, rec) {
  return rec.baseDiameter > 0 && item.diameter > 0 ? (item.diameter / rec.baseDiameter) ** 2 : 1;
}
function needsFor(items) {
  const acc = new Map();
  for (const it of items) {
    const r = getRec(it.recipeId);
    if (r) expand(r, it.count * diameterFactor(it, r), acc);
  }
  // Штучное (яйца) — только целыми.
  for (const [id, n] of acc) {
    const g = getIng(id);
    if (g && g.unit === 'шт') acc.set(id, Math.ceil(n - 1e-6));
  }
  return acc;
}
/** Цена за единицу (самая выгодная фасовка с ценой). */
function unitPrice(ing) {
  let best = 0;
  for (const p of ing.packs) if (p.price > 0 && p.size > 0 && (!best || p.price / p.size < best)) best = p.price / p.size;
  return best;
}
function recipeCost(recipe) {
  const acc = expand(recipe, 1, new Map());
  let sum = 0, missing = false;
  for (const [id, n] of acc) {
    const p = unitPrice(getIng(id));
    if (p) sum += n * p; else missing = true;
  }
  return { sum, missing, empty: !acc.size };
}
/**
 * Подбирает упаковки, чтобы закрыть нехватку: если у всех фасовок есть цена — дешевле всего,
 * иначе — с наименьшим остатком, затем наименьшим числом упаковок.
 */
function bestPacks(packs, deficit) {
  const ps = packs.filter((p) => p.size > 0);
  if (!ps.length) return null;
  const priced = ps.every((p) => p.price > 0);
  const cmp = (a, b) => {
    if (!b) return -1;
    if (priced && Math.abs(a.cost - b.cost) > 1e-9) return a.cost - b.cost;
    if (Math.abs(a.amount - b.amount) > 1e-9) return a.amount - b.amount;
    return a.count - b.count;
  };
  const mk = (counts) => {
    const combo = counts.map((n, i) => ({ pack: ps[i], n })).filter((c) => c.n > 0);
    return {
      combo,
      amount: combo.reduce((s, c) => s + c.n * c.pack.size, 0),
      cost: combo.reduce((s, c) => s + c.n * (c.pack.price || 0), 0),
      count: combo.reduce((s, c) => s + c.n, 0),
    };
  };
  let best = null;
  ps.forEach((p, i) => {
    const counts = ps.map(() => 0);
    counts[i] = Math.ceil(deficit / p.size - 1e-9);
    const c = mk(counts);
    if (cmp(c, best) < 0) best = c;
  });
  if (ps.length < 2) return best;

  // Точный перебор комбинаций (динамическое программирование по шагу НОД фасовок).
  const M = 1000;
  const ints = ps.map((p) => Math.round(p.size * M));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = ints.reduce(gcd);
  const u = ints.map((x) => x / g);
  const T = Math.ceil((deficit * M) / g - 1e-9);
  const lim = T + Math.max(...u);
  if (lim > 200000) return best;
  const cost = new Float64Array(lim + 1).fill(Infinity);
  const cnt = new Int32Array(lim + 1);
  const prev = new Int8Array(lim + 1).fill(-1);
  cost[0] = 0;
  for (let x = 0; x <= lim; x++) {
    if (cost[x] === Infinity) continue;
    for (let i = 0; i < u.length; i++) {
      const y = x + u[i];
      if (y > lim) continue;
      const c = cost[x] + (priced ? ps[i].price : 0);
      const k = cnt[x] + 1;
      if (c < cost[y] - 1e-9 || (Math.abs(c - cost[y]) <= 1e-9 && k < cnt[y])) { cost[y] = c; cnt[y] = k; prev[y] = i; }
    }
  }
  let by = -1;
  for (let y = T; y <= lim; y++) {
    if (cost[y] === Infinity) continue;
    if (by < 0) { by = y; continue; }
    const better = priced
      ? cost[y] < cost[by] - 1e-9 || (Math.abs(cost[y] - cost[by]) <= 1e-9 && (y < by || (y === by && cnt[y] < cnt[by])))
      : false; // без цен первый найденный y — минимальный остаток
    if (better) by = y;
  }
  if (by < 0) return best;
  const counts = ps.map(() => 0);
  for (let x = by; x > 0; x -= u[prev[x]]) counts[prev[x]]++;
  const c = mk(counts);
  // Страховка от округления очень мелких фасовок: комбинация обязана закрывать нехватку.
  return c.amount >= deficit - 1e-9 && cmp(c, best) < 0 ? c : best;
}

function currentItems() {
  if (state.activePlan === 'all') return state.plans.flatMap((p) => p.items);
  const p = getPlan(state.activePlan);
  return p ? p.items : [];
}
/** Ближайшая дата плана, где нужен ингредиент (для скоропорта). */
function earliestDates() {
  const m = new Map();
  for (const p of state.plans) {
    if (!p.date) continue;
    for (const id of needsFor(p.items).keys()) if (!m.has(id) || p.date < m.get(id)) m.set(id, p.date);
  }
  return m;
}
function calcRows(items) {
  const need = needsFor(items);
  const tol = state.settings.tolerance || 0;
  const rows = [];
  for (const [id, n] of need) {
    const ing = getIng(id);
    if (!ing || !(n > EPS)) continue;
    const stock = ing.stock || 0;
    const deficit = Math.max(0, n - stock);
    let combo = [], buyAmount = 0, cost = 0, small = false;
    if (deficit > EPS) {
      if (ing.packs.length) {
        const minSize = Math.min(...ing.packs.map((p) => p.size));
        // Порог действует, только если дома что-то есть: без ингредиента вообще не испечь.
        if (tol > 0 && stock > EPS && deficit <= (minSize * tol) / 100 + EPS) small = true;
        else {
          const b = bestPacks(ing.packs, deficit);
          combo = b.combo; buyAmount = b.amount; cost = b.cost;
        }
      } else buyAmount = deficit;
    }
    rows.push({
      ing, need: n, stock, deficit, combo, buyAmount, cost, small,
      costPartial: combo.some((c) => !(c.pack.price > 0)),
      leftover: stock + buyAmount - n,
      value: n * unitPrice(ing), valued: unitPrice(ing) > 0,
    });
  }
  rows.sort((a, b) => byName(a.ing, b.ing));
  return rows;
}
/** Списывает ингредиенты из запасов, возвращает список того, чего не хватило. */
function deduct(need) {
  const short = [];
  for (const [id, n] of need) {
    const g = getIng(id);
    if (!g) continue;
    if (g.stock < n - EPS) short.push(g.name);
    g.stock = Math.max(0, round(g.stock - n));
  }
  return short;
}
const recipesUsingIng = (id) => state.recipes.filter((r) => r.items.some((x) => x.ingId === id));
const recipesUsingRec = (id) => state.recipes.filter((r) => r.items.some((x) => x.recId === id));
/** Можно ли вставить рецепт sub в рецепт parent без зацикливания. */
function canUseSub(parentId, subId) {
  if (!parentId) return true;
  const reaches = (from, depth = 0) => {
    if (from === parentId) return true;
    if (depth > 20) return true;
    const r = getRec(from);
    return !!r && r.items.some((it) => it.recId && reaches(it.recId, depth + 1));
  };
  return !reaches(subId);
}
function packLabel(ing, p) {
  return `${esc(p.name || tL(L('packs'), 'pack_short'))} ${fmt(p.size)} ${U(ing.unit)}`;
}
function perUnitText(unit, size, price) {
  if (!(size > 0 && price > 0)) return '';
  const per = unit === 'шт' ? 1 : 1000;
  const label = unit === 'г' ? U('кг') : unit === 'мл' ? U('л') : U('шт');
  return `≈ ${fmt((price / size) * per)} ${esc(cur())}/${label}`;
}

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Окно снизу. guard: спрашивать перед закрытием, если что-то изменено. */
function openSheet(html, { guard = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  wrap.dirty = false;
  // Закрывающееся окно больше не принимает нажатий (защита от двойного «Готово»).
  wrap.addEventListener('click', (e) => {
    if (wrap.closing) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  if (guard) {
    wrap.addEventListener('input', () => (wrap.dirty = true));
    wrap.addEventListener('change', () => (wrap.dirty = true));
  }
  $('#sheets').appendChild(wrap);
  document.body.classList.add('noscroll');
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  $$('[data-close]', wrap).forEach((b) => (b.onclick = () => {
    if (wrap.dirty && !confirm(t('discard_confirm'))) return;
    closeSheet(wrap);
  }));
  return wrap;
}
function closeSheet(wrap) {
  if (wrap.closing) return;
  wrap.closing = true;
  if (document.activeElement) document.activeElement.blur();
  wrap.classList.remove('open');
  wrap.classList.add('closing');
  setTimeout(() => {
    wrap.remove();
    if (!$('#sheets').children.length) document.body.classList.remove('noscroll');
  }, 280);
}
const sheetHead = (title, { cancel = true, doneAttr = 'data-save' } = {}) => `
  <div class="sheet-head">
    ${cancel ? `<button type="button" data-close>${t('cancel')}</button>` : '<span></span>'}
    <h2>${title}</h2>
    <button type="button" class="primary" ${doneAttr}>${t('done')}</button>
  </div>`;
const stepperHtml = (attrs, value) => `
  <div class="stepper">
    <button type="button" data-step="-1" aria-label="${t('less')}">−</button>
    <input ${attrs} inputmode="decimal" value="${inVal(value)}" autocomplete="off">
    <button type="button" data-step="1" aria-label="${t('more')}">+</button>
  </div>`;
/** Кнопки −/+ внутри окна. */
function bindSteppers(root, { min = 0 } = {}) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b || !root.contains(b)) return;
    const inp = b.parentElement.querySelector('input');
    const v = num(inp.value);
    inp.value = inVal(Math.max(min, round((Number.isFinite(v) ? v : 0) + +b.dataset.step, 2)));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
let invMode = false;

function setTab(name) {
  tab = name;
  invMode = false;
  try { sessionStorage.setItem('icalc.tab', name); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const tb = TABS[tab];
  $('#title').textContent = t(tb.title);
  const b = $('#topAction');
  const showAction = tb.action && !(tab === 'plan' && (!state.recipes.length || !getPlan(state.activePlan)));
  b.hidden = !showAction;
  if (showAction) {
    b.textContent = t(tb.action[0]);
    b.onclick = tb.action[1];
  }
  try {
    $('#view').innerHTML = tb.render();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="hint error">${t('render_error')}<br><small>${esc(e.message)}</small></div>`;
  }
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  if (tab === 'ingredients') applyIngSearch();
  // Выбранный план всегда виден в ленте планов.
  const chips = $('#view .chips'), act = chips && $('.chip.active', chips);
  if (act) chips.scrollLeft = Math.max(0, act.offsetLeft - (chips.clientWidth - act.offsetWidth) / 2);
}

/* =========================================================
   Ингредиенты
   ========================================================= */
function packsText(i) {
  if (!i.packs.length) return `<span class="warn">${t('pack_missing')}</span>`;
  const parts = i.packs.slice(0, 2).map((p) => `${packLabel(i, p)}${p.price > 0 ? ` · ${money(p.price)}` : ''}`);
  if (i.packs.length > 2) parts.push(`+${i.packs.length - 2}`);
  return parts.join(', ');
}
function ingTags(i) {
  return `${i.store ? `<span class="tag">${esc(i.store)}</span>` : ''}${i.perishable ? `<span class="tag warn-tag">${t('perishable_tag')}</span>` : ''}`;
}

function renderIngredients() {
  if (!state.ingredients.length) {
    return empty('🧈', t('ing_empty_title'), t('ing_empty_text'), t('ing_empty_btn'), 'new-ing');
  }
  const list = [...state.ingredients].sort(byName);
  const rows = list.map((i) => invMode ? `
      <li class="row" data-name="${esc(searchKey(i))}">
        <div class="row-main">
          <div class="row-title">${esc(i.name)}</div>
          <div class="row-sub">${packsText(i)}</div>
        </div>
        <div class="inv-input">
          <input data-stock data-id="${i.id}" inputmode="decimal" value="${inVal(i.stock)}" aria-label="${esc(i.name)}" autocomplete="off">
          <span>${U(i.unit)}</span>
        </div>
      </li>` : `
      <li class="row tap" data-action="edit-ing" data-id="${i.id}" data-name="${esc(searchKey(i))}">
        <div class="row-main">
          <div class="row-title">${esc(i.name)} ${ingTags(i)}</div>
          <div class="row-sub">${packsText(i)}</div>
        </div>
        <div class="row-side ${i.stock > EPS ? '' : 'zero'}">
          <div class="big">${fmt(i.stock || 0)} ${U(i.unit)}</div>
          <div class="small">${t('at_home')}</div>
        </div>
      </li>`).join('');
  return `<div class="toolbar">
      <input type="search" id="ingSearch" placeholder="${t('search')}" value="${esc(ingSearch)}" autocomplete="off">
      <button type="button" class="chip-btn ${invMode ? 'on' : ''}" data-action="toggle-inv">${invMode ? t('done') : t('inventory')}</button>
    </div>
    ${invMode ? `<p class="muted small-text hint-line">${t('inventory_hint')}</p>` : ''}
    <ul class="list">${rows}</ul>
    ${invMode ? '' : `<p class="muted small-text hint-line">${t('ing_list_hint')}</p>`}`;
}

function applyIngSearch() {
  const q = normSearch(ingSearch.trim());
  $$('#view [data-name]').forEach((li) => (li.hidden = q && !li.dataset.name.includes(q)));
}

/** Поля названия на всех языках; первым — язык, выбранный для этой категории. */
function namesFields(names, cat, phKey) {
  const first = L(cat);
  const order = [first, ...LANG_CODES.filter((c) => c !== first)];
  return `<div class="field"><span>${t('name')}</span>
    <div class="names2">${order.map((c) => `
      <label class="lang-input"><b>${c.toUpperCase()}</b>
        <input name="name_${c}" data-lang="${c}" value="${esc(names[c] || '')}" placeholder="${c === first ? t(phKey) : ''}" autocomplete="off"></label>`).join('')}
    </div>
    <div class="note">${t('names_note')}</div></div>`;
}
/** Когда одно название введено, а другое пустое — подставляем перевод из словаря. */
function bindAutofill(el) {
  el.addEventListener('change', (e) => {
    const inp = e.target;
    if (!inp.name || !inp.name.startsWith('name_')) return;
    for (const c of LANG_CODES) {
      if (c === inp.dataset.lang) continue;
      const other = $(`[name="name_${c}"]`, el);
      if (other && !other.value.trim()) {
        const g = guessName(inp.value, inp.dataset.lang, c);
        if (g) { other.value = g; other.classList.add('auto'); }
      }
    }
  });
  el.addEventListener('input', (e) => e.target.classList && e.target.classList.remove('auto'));
}
function readNamesFrom(el, max = 100) {
  const n = {};
  for (const c of LANG_CODES) {
    const v = $(`[name="name_${c}"]`, el).value.trim().slice(0, max);
    if (v) n[c] = v;
  }
  return n;
}
const packTypeOptions = (sel) => PACK_TYPES.map((tp) =>
  `<option value="${tp}" ${tp === sel ? 'selected' : ''}>${esc(tL(L('packs'), 'pack_' + tp))}</option>`).join('')
  + `<option value="custom" ${sel === 'custom' ? 'selected' : ''}>${t('pack_custom')}</option>`;

function editIngredient(id, onSaved, presetName = '') {
  const i = id ? getIng(id) : null;
  const d = i ? JSON.parse(JSON.stringify(i))
    : { names: presetName ? { [L('ingredients')]: presetName } : {}, unit: 'г', stock: 0, packs: [], pieceWeight: 0, store: '', perishable: false };
  const packs = d.packs.map((p) => ({ id: p.id, size: inVal(p.size), price: inVal(p.price), type: p.type, names: { ...p.names } }));
  if (!packs.length) packs.push({ id: uid(), size: '', price: '', type: 'pack', names: {} });
  const usedIn = i ? recipesUsingIng(i.id) : [];
  const stores = [...new Set(state.ingredients.map((x) => x.store).filter(Boolean))].sort(collator.compare);

  const el = openSheet(`
    ${sheetHead(i ? t('ing_title') : t('ing_new_title'))}
    <div class="sheet-body">
      ${namesFields(d.names, 'ingredients', 'ing_name_ph')}
      <label class="field"><span>${t('unit')}</span>
        <select name="unit" ${usedIn.length ? 'disabled' : ''}>${BASE_UNITS.map((u) => `<option value="${u}" ${u === d.unit ? 'selected' : ''}>${t('unitname_' + u)}</option>`).join('')}</select>
        <div class="note">${usedIn.length ? t('unit_locked', { list: esc(usedIn.map((r) => r.name).join(', ')) }) : t('unit_note')}</div></label>
      <label class="field pw-field" ${d.unit === 'шт' ? '' : 'hidden'}><span>${t('piece_weight')}</span>
        <input name="pieceWeight" inputmode="decimal" value="${inVal(d.pieceWeight || '')}" placeholder="60" autocomplete="off">
        <div class="note">${t('piece_weight_note')}</div></label>

      <div class="group-title">${t('packs_group')}</div>
      <div class="pack-head"><span>${t('pack_size')}, <b class="u">${U(d.unit)}</b></span><span>${t('pack_type')}</span><span>${t('pack_price', { cur: esc(cur()) })}</span><span></span></div>
      <div class="pack-rows"></div>
      <button type="button" class="add-row" data-addpack-row>${t('add_pack_row')}</button>
      <div class="note">${t('packs_note')}</div>

      <div class="group-title">${t('shop_group')}</div>
      <label class="field"><span>${t('store')}</span>
        <input name="store" list="storeList" value="${esc(d.store)}" placeholder="${t('store_ph')}" autocomplete="off">
        <datalist id="storeList">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
      <label class="check-field"><input type="checkbox" name="perishable" ${d.perishable ? 'checked' : ''}>
        <span><b>${t('perishable')}</b><br><small>${t('perishable_note')}</small></span></label>

      <div class="group-title">${t('stock_group')}</div>
      <label class="field"><span>${t('stock_now')}, <b class="u">${U(d.unit)}</b></span>
        <div class="with-btn">
          <input name="stock" inputmode="decimal" value="${inVal(d.stock)}" placeholder="0" autocomplete="off">
          <button type="button" data-addpack>${t('add_pack')}</button>
        </div></label>

      ${i ? `<div class="btn-stack"><button type="button" class="btn danger" data-delete>${t('delete_ing')}</button></div>` : ''}
    </div>`, { guard: true });
  bindAutofill(el);

  const f = (n) => $(`[name="${n}"]`, el);
  const unitNow = () => f('unit').value;
  const rowsEl = $('.pack-rows', el);
  const drawPacks = () => {
    rowsEl.innerHTML = packs.map((p, k) => `
      <div class="pack-row" data-k="${k}">
        <input data-f="size" inputmode="decimal" value="${esc(p.size)}" placeholder="1000" aria-label="${t('pack_size')}" autocomplete="off">
        <select data-f="type" aria-label="${t('pack_type')}">${packTypeOptions(p.type)}</select>
        <input data-f="price" inputmode="decimal" value="${esc(p.price)}" placeholder="0" aria-label="${t('pack_price', { cur: '' })}" autocomplete="off">
        <button type="button" class="del" data-delpack aria-label="${t('remove')}">✕</button>
        ${p.type === 'custom' ? `<div class="pack-custom">${LANG_CODES.map((c) => `
          <label class="lang-input"><b>${c.toUpperCase()}</b><input data-f="cn" data-lang="${c}" value="${esc(p.names[c] || '')}" placeholder="${c === L('packs') ? t('pack_custom_names') : ''}" autocomplete="off"></label>`).join('')}</div>` : ''}
        <div class="ppu">${perUnitText(unitNow(), num(p.size), num(p.price))}</div>
      </div>`).join('');
  };
  drawPacks();
  rowsEl.addEventListener('input', (e) => {
    const row = e.target.closest('.pack-row');
    if (!row) return;
    const p = packs[+row.dataset.k];
    const fld = e.target.dataset.f;
    if (fld === 'cn') p.names[e.target.dataset.lang] = e.target.value;
    else if (fld === 'size' || fld === 'price') p[fld] = e.target.value;
    $('.ppu', row).innerHTML = perUnitText(unitNow(), num(p.size), num(p.price));
  });
  rowsEl.addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'type') return;
    const p = packs[+e.target.closest('.pack-row').dataset.k];
    p.type = e.target.value;
    drawPacks();
    if (p.type === 'custom') $(`.pack-row[data-k="${packs.indexOf(p)}"] [data-f="cn"]`, rowsEl).focus();
  });
  rowsEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-delpack]')) return;
    packs.splice(+e.target.closest('.pack-row').dataset.k, 1);
    if (!packs.length) packs.push({ id: uid(), size: '', price: '', type: 'pack', names: {} });
    el.dirty = true;
    drawPacks();
  });
  $('[data-addpack-row]', el).onclick = () => {
    packs.push({ id: uid(), size: '', price: '', type: packs[packs.length - 1]?.type || 'pack', names: {} });
    drawPacks();
    $$('.pack-row [data-f="size"]', rowsEl).pop().focus();
  };
  if (!i) setTimeout(() => f('name_' + L('ingredients')).focus(), 300);
  f('unit').onchange = () => {
    $$('.u', el).forEach((u) => (u.textContent = U(unitNow())));
    $('.pw-field', el).hidden = unitNow() !== 'шт';
    drawPacks();
  };
  $('[data-addpack]', el).onclick = () => {
    const ps = num(packs.find((p) => num(p.size) > 0)?.size);
    if (!(ps > 0)) return toast(t('need_pack_first'));
    const st = num(f('stock').value);
    f('stock').value = inVal(round((Number.isFinite(st) ? st : 0) + ps));
    el.dirty = true;
  };
  $('[data-save]', el).onclick = guarded(() => {
    const names = readNamesFrom(el);
    if (!Object.keys(names).length) { f('name_' + L('ingredients')).focus(); throw new UserError(t('name_required')); }
    if (sameName(state.ingredients, i, names)) throw new UserError(t('dup_ing'));
    const unit = usedIn.length ? i.unit : unitNow();
    const outPacks = [];
    $$('.pack-row', rowsEl).forEach((row) => {
      const p = packs[+row.dataset.k];
      const sizeEl = $('[data-f="size"]', row), priceEl = $('[data-f="price"]', row);
      const cn = {};
      if (p.type === 'custom') for (const c of LANG_CODES) { const v = (p.names[c] || '').trim().slice(0, 40); if (v) cn[c] = v; }
      if (!sizeEl.value.trim() && !priceEl.value.trim() && !Object.keys(cn).length) return;
      if (!sizeEl.value.trim()) { sizeEl.classList.add('invalid'); sizeEl.focus(); throw new UserError(t('pack_size_required')); }
      outPacks.push(bindName({
        id: p.id || uid(),
        size: readNum(sizeEl, { positive: true }),
        price: readNum(priceEl),
        type: p.type,
        names: cn,
      }, 'packs'));
    });
    const obj = {
      id: i ? i.id : uid(),
      names,
      unit,
      stock: readNum(f('stock')),
      packs: outPacks,
      pieceWeight: unit === 'шт' ? readNum(f('pieceWeight')) : 0,
      store: f('store').value.trim().slice(0, 40),
      perishable: f('perishable').checked,
    };
    // Если вес штуки убрали, а рецепты считают это в граммах — запрещаем.
    if (i && unit === 'шт' && !obj.pieceWeight && usedIn.some((r) => r.items.some((x) => x.ingId === i.id && x.u !== 'шт'))) {
      f('pieceWeight').classList.add('invalid');
      throw new UserError(t('piece_weight_required'));
    }
    if (i) Object.assign(i, obj); else state.ingredients.push(bindIng(obj));
    save();
    closeSheet(el);
    render();
    if (onSaved) onSaved(i || obj);
  });
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    const msg = usedIn.length
      ? t('ing_used_confirm', { name: i.name, list: usedIn.map((r) => r.name).join(', ') })
      : t('ing_delete_confirm', { name: i.name });
    if (!confirm(msg)) return;
    usedIn.forEach((r) => (r.items = r.items.filter((x) => x.ingId !== id)));
    state.ingredients = state.ingredients.filter((x) => x.id !== id);
    uncheckEverywhere(id);
    save();
    closeSheet(el);
    render();
    toast(t('ing_deleted'));
  };
}

/** Выбор ингредиента (или полуфабриката) с поиском. */
function openPicker({ parentId, onPick, withRecipes = true }) {
  const el = openSheet(`
    <div class="sheet-head"><button type="button" data-close>${t('cancel')}</button><h2>${t('pick_ing_title')}</h2><span></span></div>
    <div class="sheet-body">
      <div class="search"><input type="search" class="picker-search" placeholder="${t('search')}" autocomplete="off"></div>
      <ul class="list picker-list"></ul>
    </div>`);
  const ul = $('.picker-list', el);
  const input = $('.picker-search', el);
  const draw = () => {
    const raw = input.value.trim();
    const q = normSearch(raw);
    const ings = [...state.ingredients].sort(byName).filter((i) => !q || searchKey(i).includes(q));
    const recs = withRecipes
      ? state.recipes.filter((r) => r.id !== parentId && canUseSub(parentId, r.id) && (!q || searchKey(r).includes(q)))
        .sort((a, b) => (b.isPrep - a.isPrep) || byName(a, b))
      : [];
    ul.innerHTML = `
      <li class="row tap accent-row" data-new>＋ ${raw ? t('new_ing_named', { q: esc(raw) }) : t('new_ing_option')}</li>
      ${ings.map((i) => `<li class="row tap" data-ing="${i.id}"><div class="row-main"><div class="row-title">${esc(i.name)}</div></div><span class="muted">${U(i.unit)}</span></li>`).join('')}
      ${recs.length ? `<li class="row list-head">${t('preps_section')}</li>` : ''}
      ${recs.map((r) => `<li class="row tap" data-rec="${r.id}"><div class="row-main"><div class="row-title">🍰 ${esc(r.name)}</div>${r.isPrep ? `<div class="row-sub">${t('prep_tag')}</div>` : ''}</div></li>`).join('')}`;
  };
  draw();
  input.addEventListener('input', draw);
  setTimeout(() => input.focus(), 300);
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (li.dataset.ing) { closeSheet(el); onPick({ ingId: li.dataset.ing }); }
    else if (li.dataset.rec) { closeSheet(el); onPick({ recId: li.dataset.rec }); }
    else if ('new' in li.dataset) {
      editIngredient(null, (ni) => { closeSheet(el); onPick({ ingId: ni.id }); }, input.value.trim());
    }
  });
}

/* =========================================================
   Рецепты
   ========================================================= */
/** В составе есть позиция, которую нельзя пересчитать (и она не попадёт в расчёт). */
function recipeHasProblem(r) {
  return r.items.some((it) => {
    const g = it.ingId ? getIng(it.ingId) : getRec(it.recId);
    return g && !itemUnits(g).includes(it.u);
  });
}

function costText(c) {
  if (c.empty || (!c.sum && c.missing)) return '';
  return `≈ ${money(c.sum)}${c.missing ? '*' : ''} ${t('per_batch')}`;
}

function renderRecipes() {
  if (!state.recipes.length) {
    return empty('📖', t('rec_empty_title'), t('rec_empty_text'), t('rec_empty_btn'), 'new-rec');
  }
  const inPlan = new Map();
  for (const p of currentItems()) inPlan.set(p.recipeId, round((inPlan.get(p.recipeId) || 0) + p.count, 2));
  const row = (r) => {
    const c = inPlan.get(r.id);
    const cost = costText(recipeCost(r));
    return `<li class="row tap" data-action="edit-rec" data-id="${r.id}">
      <div class="row-main">
        <div class="row-title">${esc(r.name)}</div>
        <div class="row-sub">${[t('n_ingredients', r.items.length), cost, esc(r.note)].filter(Boolean).join(' · ')}</div>
        ${recipeHasProblem(r) ? `<div class="row-sub warn">⚠ ${t('recipe_problem')}</div>` : ''}
      </div>
      ${c ? `<span class="badge" title="${t('in_plan')}">${fmt(c)}</span>` : ''}
      <button type="button" class="chip-btn" data-action="add-to-plan" data-id="${r.id}">${t('to_plan')}</button>
    </li>`;
  };
  const main = state.recipes.filter((r) => !r.isPrep).sort(byName);
  const preps = state.recipes.filter((r) => r.isPrep).sort(byName);
  let html = '';
  if (main.length) html += `${preps.length ? `<div class="section-title"><span>${t('products_section')}</span></div>` : ''}<ul class="list">${main.map(row).join('')}</ul>`;
  if (preps.length) html += `<div class="section-title"><span>${t('preps_section')}</span></div><ul class="list">${preps.map(row).join('')}</ul>`;
  if (state.recipes.some((r) => { const c = recipeCost(r); return c.missing && !c.empty; })) html += `<p class="muted small-text hint-line">${t('cost_missing_note')}</p>`;
  return html;
}

function editRecipe(id, copyFrom) {
  const r = id ? getRec(id) : null;
  const src = r || copyFrom;
  const d = src ? JSON.parse(JSON.stringify(src)) : { names: {}, note: '', isPrep: false, yieldWeight: 0, baseDiameter: 0, loss: 0, items: [] };
  if (copyFrom) for (const c of Object.keys(d.names)) d.names[c] = `${d.names[c]} ${tL(c, 'copy_suffix')}`;
  const items = d.items.map((it) => ({ ...it, qty: inVal(it.qty) }));

  const el = openSheet(`
    ${sheetHead(r ? t('rec_title') : t('rec_new_title'))}
    <div class="sheet-body">
      ${namesFields(d.names, 'recipes', 'rec_name_ph')}
      <label class="field"><span>${t('note')}</span>
        <input name="note" value="${esc(d.note)}" placeholder="${t('note_ph')}" autocomplete="off"></label>
      <label class="check-field"><input type="checkbox" name="isPrep" ${d.isPrep ? 'checked' : ''}>
        <span><b>${t('is_prep')}</b><br><small>${t('is_prep_note')}</small></span></label>
      <div class="grid3">
        <label class="field"><span>${t('yield_weight')}</span>
          <input name="yieldWeight" inputmode="decimal" value="${inVal(d.yieldWeight || '')}" placeholder="—" autocomplete="off"></label>
        <label class="field"><span>${t('base_diameter')}</span>
          <input name="baseDiameter" inputmode="decimal" value="${inVal(d.baseDiameter || '')}" placeholder="—" autocomplete="off"></label>
        <label class="field"><span>${t('loss')}</span>
          <input name="loss" inputmode="decimal" value="${inVal(d.loss || '')}" placeholder="0" autocomplete="off"></label>
      </div>
      <div class="note">${t('recipe_params_note')}</div>

      <div class="group-title">${t('rec_ings_group')}</div>
      <div class="rec-rows"></div>
      <button type="button" class="add-row" data-addrow>${t('add_ing_row')}</button>
      <div class="cost-line"></div>
      ${r ? `<div class="btn-stack">
        <button type="button" class="btn plain" data-copy>${t('copy_recipe')}</button>
        <button type="button" class="btn danger" data-delete>${t('delete_recipe')}</button>
      </div>` : ''}
    </div>`, { guard: true });

  const f = (n) => $(`[name="${n}"]`, el);
  const rowsEl = $('.rec-rows', el);
  const target = (it) => (it.ingId ? getIng(it.ingId) : it.recId ? getRec(it.recId) : null);
  const drawRows = () => {
    rowsEl.innerHTML = items.length ? items.map((it, k) => {
      const g = target(it);
      const units = itemUnits(g);
      // Единица, которую сейчас нельзя пересчитать (например, крем в граммах без выхода), — показываем и подсвечиваем.
      const bad = g && it.u && !units.includes(it.u);
      if (bad) units.push(it.u);
      return `<div class="rec-row ${bad ? 'problem' : ''}" data-k="${k}">
        <button type="button" class="pick-btn" data-pick>${g ? (it.recId ? '🍰 ' : '') + esc(g.name) : t('choose')}</button>
        <input data-f="qty" inputmode="decimal" placeholder="0" value="${esc(it.qty)}" aria-label="${t('qty')}" autocomplete="off">
        <select data-f="u" aria-label="${t('unit')}" ${units.length > 1 ? '' : 'disabled'}>${units.map((u) => `<option value="${u}" ${u === it.u ? 'selected' : ''}>${U(u)}</option>`).join('')}</select>
        <button type="button" class="del" data-delrow aria-label="${t('remove')}">✕</button>
      </div>${bad ? `<div class="problem-note">${t('item_unit_problem', { name: esc(g.name) })}</div>` : ''}`;
    }).join('') : `<p class="muted small-text">${t('no_items_yet')}</p>`;
  };
  const draft = () => ({
    loss: Math.max(0, num(f('loss').value) || 0),
    items: items.filter((it) => (it.ingId || it.recId) && num(it.qty) > 0).map((it) => ({ ...it, qty: num(it.qty) })),
  });
  const updateCost = () => {
    const c = recipeCost(draft());
    $('.cost-line', el).innerHTML = c.empty ? '' : `${t('batch_cost')}: <b>${c.sum || !c.missing ? money(c.sum) : '—'}${c.missing ? '*' : ''}</b>${c.missing ? `<br><small>${t('cost_missing_note')}</small>` : ''}`;
  };
  const pick = (k) => openPicker({
    parentId: r ? r.id : null,
    onPick: (sel) => {
      const it = k == null ? (items.push({ qty: '' }), items[items.length - 1]) : items[k];
      delete it.ingId; delete it.recId;
      Object.assign(it, sel);
      it.u = sel.ingId ? getIng(sel.ingId).unit : 'batch';
      el.dirty = true;
      drawRows();
      updateCost();
      const idx = k == null ? items.length - 1 : k;
      setTimeout(() => $(`.rec-row[data-k="${idx}"] [data-f="qty"]`, rowsEl)?.focus(), 320);
    },
  });
  drawRows();
  updateCost();
  bindAutofill(el);
  if (!src) setTimeout(() => f('name_' + L('recipes')).focus(), 300);

  rowsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.rec-row');
    if (!row) return;
    if (e.target.closest('[data-pick]')) pick(+row.dataset.k);
    if (e.target.closest('[data-delrow]')) {
      items.splice(+row.dataset.k, 1);
      el.dirty = true;
      drawRows();
      updateCost();
    }
  });
  rowsEl.addEventListener('input', (e) => {
    const row = e.target.closest('.rec-row');
    if (row && e.target.dataset.f === 'qty') { items[+row.dataset.k].qty = e.target.value; updateCost(); }
  });
  rowsEl.addEventListener('change', (e) => {
    const row = e.target.closest('.rec-row');
    if (row && e.target.dataset.f === 'u') { items[+row.dataset.k].u = e.target.value; drawRows(); updateCost(); }
  });
  f('loss').addEventListener('input', updateCost);
  $('[data-addrow]', el).onclick = () => pick(null);

  $('[data-save]', el).onclick = guarded(() => {
    const names = readNamesFrom(el);
    if (!Object.keys(names).length) { f('name_' + L('recipes')).focus(); throw new UserError(t('name_required')); }
    if (sameName(state.recipes, r, names)) throw new UserError(t('dup_rec'));
    const yieldWeight = readNum(f('yieldWeight'));
    const baseDiameter = readNum(f('baseDiameter'));
    const loss = readNum(f('loss'), { max: 500 });
    const merged = new Map();
    $$('.rec-row', rowsEl).forEach((row) => {
      const it = items[+row.dataset.k];
      if (!it.ingId && !it.recId) return;
      const g = target(it);
      if (g && !itemUnits(g).includes(it.u)) throw new UserError(t('item_unit_problem', { name: g.name }));
      const q = readNum($('[data-f="qty"]', row), { required: true, positive: true });
      const key = (it.ingId || 'r:' + it.recId) + '|' + it.u;
      const prev = merged.get(key);
      if (prev) prev.qty = round(prev.qty + q, 4);
      else merged.set(key, it.ingId ? { ingId: it.ingId, qty: q, u: it.u } : { recId: it.recId, qty: q, u: it.u });
    });
    if (!merged.size) throw new UserError(t('need_one_ing'));
    if (r && !yieldWeight && recipesUsingRec(r.id).some((x) => x.items.some((it) => it.recId === r.id && it.u !== 'batch'))) {
      f('yieldWeight').classList.add('invalid');
      throw new UserError(t('yield_required_used'));
    }
    const obj = {
      id: r ? r.id : uid(),
      names,
      note: f('note').value.trim().slice(0, 200),
      isPrep: f('isPrep').checked,
      yieldWeight, baseDiameter, loss,
      items: [...merged.values()],
    };
    if (r) Object.assign(r, obj); else state.recipes.push(bindName(obj, 'recipes'));
    save();
    closeSheet(el);
    render();
    toast(r ? t('rec_saved') : t('rec_added'));
  });

  const copyBtn = $('[data-copy]', el);
  if (copyBtn) copyBtn.onclick = () => {
    if (el.dirty && !confirm(t('discard_confirm'))) return;
    closeSheet(el);
    setTimeout(() => editRecipe(null, r), 300);
  };
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    const usedIn = recipesUsingRec(r.id);
    const msg = usedIn.length
      ? t('rec_used_confirm', { name: r.name, list: usedIn.map((x) => x.name).join(', ') })
      : t('rec_delete_confirm', { name: r.name });
    if (!confirm(msg)) return;
    usedIn.forEach((x) => (x.items = x.items.filter((it) => it.recId !== r.id)));
    state.recipes = state.recipes.filter((x) => x.id !== r.id);
    state.plans.forEach((p) => (p.items = p.items.filter((it) => it.recipeId !== r.id)));
    save();
    closeSheet(el);
    render();
    toast(t('rec_deleted'));
  };
}

/* =========================================================
   Планы и список покупок
   ========================================================= */
/** План, в который добавляем рецепты (создаётся при необходимости). */
function targetPlan() {
  let p = getPlan(state.activePlan);
  if (p) return p;
  if (!state.plans.length) {
    p = { id: uid(), name: '', date: '', items: [] };
    state.plans.push(p);
  } else p = sortPlans()[0];
  state.activePlan = p.id;
  return p;
}
function addToPlan(recipeId, delta = 1, plan = targetPlan()) {
  const it = plan.items.find((x) => x.recipeId === recipeId);
  if (it) it.count = round(it.count + delta, 2);
  else if (delta > 0) plan.items.push({ recipeId, count: delta, diameter: 0 });
  plan.items = plan.items.filter((x) => x.count > EPS);
  save();
  return plan;
}

function pickRecipesForPlan() {
  const plan = targetPlan();
  const el = openSheet(`
    <div class="sheet-head"><span></span><h2>${t('pick_title')}</h2>
      <button type="button" class="primary" data-close>${t('done')}</button></div>
    <div class="sheet-body">
      <p class="muted small-text hint-line">${t('pick_hint', { plan: esc(planTitle(plan)) })}</p>
      <ul class="list pick-list"></ul>
    </div>`);
  const ul = $('.pick-list', el);
  const draw = () => {
    const inPlan = new Map(plan.items.map((p) => [p.recipeId, p.count]));
    const list = [...state.recipes].sort((a, b) => (a.isPrep - b.isPrep) || byName(a, b));
    ul.innerHTML = list.map((r) => `
      <li class="row tap" data-id="${r.id}">
        <div class="row-main"><div class="row-title">${r.isPrep ? '🍰 ' : ''}${esc(r.name)}</div>${r.note ? `<div class="row-sub">${esc(r.note)}</div>` : ''}</div>
        ${inPlan.get(r.id) ? `<span class="badge">${fmt(inPlan.get(r.id))}</span>` : '<span class="chip-btn">+ 1</span>'}
      </li>`).join('');
  };
  draw();
  ul.onclick = (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    addToPlan(li.dataset.id, 1, plan);
    draw();
    render();
  };
}

/** Выбор плана из списка. */
function choosePlan(onPick) {
  const el = openSheet(`
    <div class="sheet-head"><button type="button" data-close>${t('cancel')}</button><h2>${t('choose_plan_title')}</h2><span></span></div>
    <div class="sheet-body">
      <ul class="list">${sortPlans().map((p) => `
        <li class="row tap" data-id="${p.id}"><div class="row-main"><div class="row-title">${esc(planTitle(p))}</div>
          <div class="row-sub">${p.date ? fmtDate(p.date) : t('no_date')}</div></div></li>`).join('')}</ul>
    </div>`);
  $('.list', el).onclick = (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    closeSheet(el);
    onPick(getPlan(li.dataset.id));
  };
}

function editPlan(id) {
  const p = id ? getPlan(id) : null;
  const el = openSheet(`
    ${sheetHead(p ? t('plan_edit_title') : t('plan_new_title'))}
    <div class="sheet-body">
      <label class="field"><span>${t('plan_name')}</span>
        <input name="name" value="${esc(p ? p.name : '')}" placeholder="${t('plan_name_ph')}" autocomplete="off"></label>
      <label class="field"><span>${t('plan_date')}</span>
        <input name="date" type="date" value="${p ? p.date : ''}"></label>
      ${p ? `<div class="btn-stack"><button type="button" class="btn danger" data-delete>${t('plan_delete')}</button></div>` : ''}
    </div>`, { guard: true });
  if (!p) setTimeout(() => $('[name="name"]', el).focus(), 300);
  $('[data-save]', el).onclick = () => {
    const name = $('[name="name"]', el).value.trim().slice(0, 60);
    const date = $('[name="date"]', el).value;
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
    if (p) Object.assign(p, { name, date: ok });
    else {
      const np = { id: uid(), name, date: ok, items: [] };
      state.plans.push(np);
      state.activePlan = np.id;
    }
    save();
    closeSheet(el);
    render();
  };
  const del = $('[data-delete]', el);
  if (del) del.onclick = () => {
    if (!confirm(t('plan_delete_confirm', { name: planTitle(p) }))) return;
    state.plans = state.plans.filter((x) => x !== p);
    delete state.checked[p.id];
    if (state.plans.length < 2) delete state.checked.all;
    state.activePlan = (sortPlans()[0] || {}).id || null;
    save();
    closeSheet(el);
    render();
    toast(t('plan_deleted'));
  };
}

function planChips() {
  const plans = sortPlans();
  const chip = (id, label, active) => `<button type="button" class="chip ${active ? 'active' : ''}" data-action="select-plan" data-id="${id}">${label}</button>`;
  return `<div class="chips">
    ${plans.length > 1 ? chip('all', t('all_plans_chip', { n: plans.length }), state.activePlan === 'all') : ''}
    ${plans.map((p) => chip(p.id, `${esc(planTitle(p))}${p.date ? ` · ${fmtDateShort(p.date)}` : ''}`, p.id === state.activePlan)).join('')}
    <button type="button" class="chip add" data-action="new-plan" aria-label="${t('plan_new_title')}">＋</button>
  </div>`;
}

function renderPlan() {
  if (!state.recipes.length) {
    return empty('🎂', t('welcome_title'), t('welcome_text'),
      state.ingredients.length ? t('rec_empty_btn') : t('add_ings_btn'),
      state.ingredients.length ? 'goto-recipes' : 'goto-ingredients');
  }
  if (!state.plans.length) {
    return empty('🗓️', t('no_plans_title'), t('no_plans_text'), t('plan_new_title'), 'new-plan');
  }
  if (state.activePlan !== 'all' && !getPlan(state.activePlan)) state.activePlan = sortPlans()[0].id;

  let html = planChips();
  const all = state.activePlan === 'all';
  if (all) {
    html += `<div class="section-title"><span>${t('all_plans_title')}</span></div>
      <ul class="list">${sortPlans().map((p) => `
        <li class="row tap" data-action="select-plan" data-id="${p.id}">
          <div class="row-main"><div class="row-title">${esc(planTitle(p))}</div>
            <div class="row-sub">${p.date ? fmtDate(p.date) : t('no_date')} · ${p.items.map((it) => `${esc(getRec(it.recipeId)?.name || '')} × ${fmt(it.count)}`).join(', ') || t('plan_is_empty')}</div></div>
        </li>`).join('')}</ul>`;
  } else {
    const p = getPlan(state.activePlan);
    html += `<div class="plan-head">
        <div><div class="plan-name">${esc(planTitle(p))}</div><div class="row-sub">${p.date ? fmtDate(p.date) : t('no_date')}</div></div>
        <button type="button" class="chip-btn" data-action="edit-plan" data-id="${p.id}">✎ ${t('edit')}</button>
      </div>
      <div class="section-title"><span>${t('what_we_bake')}</span></div>`;
    if (!p.items.length) return html + `<div class="hint">${t('plan_empty')}</div>`;
    html += `<ul class="list">${p.items.map((it) => {
      const r = getRec(it.recipeId);
      if (!r) return '';
      const c = recipeCost(r);
      const k = diameterFactor(it, r);
      return `<li class="row plan-row">
        <div class="row-main">
          <div class="row-title">${r.isPrep ? '🍰 ' : ''}${esc(r.name)}</div>
          <div class="row-sub">${[esc(r.note), c.empty || (!c.sum && c.missing) ? '' : `≈ ${money(c.sum * it.count * k)}${c.missing ? '*' : ''}`].filter(Boolean).join(' · ')}</div>
          ${recipeHasProblem(r) ? `<div class="row-sub warn">⚠ ${t('recipe_problem')}</div>` : ''}
          ${r.baseDiameter > 0 ? `<label class="dia">Ø <input data-plan-dia data-id="${r.id}" inputmode="decimal" value="${inVal(it.diameter || '')}" placeholder="${fmt(r.baseDiameter)}" autocomplete="off"> ${t('cm')}
            ${k !== 1 ? `<span class="muted">×${fmt(k)}</span>` : ''}</label>` : ''}
          <button type="button" class="link-btn" data-action="bake-one" data-id="${r.id}">✓ ${t('bake_one')}</button>
        </div>
        <div class="stepper">
          <button type="button" data-action="plan-dec" data-id="${r.id}" aria-label="${t('less')}">−</button>
          <input data-plan-count data-id="${r.id}" inputmode="decimal" value="${inVal(it.count)}" aria-label="${t('batches')}" autocomplete="off">
          <button type="button" data-action="plan-inc" data-id="${r.id}" aria-label="${t('more')}">+</button>
        </div>
      </li>`;
    }).join('')}</ul>`;
  }

  const items = currentItems();
  const rows = calcRows(items);
  const buy = rows.filter((r) => r.buyAmount > EPS);
  const small = rows.filter((r) => r.small);
  const enough = rows.filter((r) => r.deficit <= EPS);
  // Отметки «куплено» только для того, что сейчас в списке.
  const buyIds = new Set(buy.map((r) => r.ing.id));
  const ch = checks();
  for (const k of Object.keys(ch)) if (!buyIds.has(k)) delete ch[k];
  const dates = all ? earliestDates() : null;
  const total = buy.reduce((s, r) => s + r.cost, 0);
  const totalPartial = buy.some((r) => r.costPartial || (!r.cost && r.buyAmount > EPS));
  const value = rows.reduce((s, r) => s + r.value, 0);
  const valuePartial = rows.some((r) => !r.valued);

  html += `<div class="section-title"><span>${t('buy_title')}</span><span>${buy.length ? t('positions', { n: buy.length }) : ''}</span></div>`;
  if (!items.length) html += `<div class="hint">${t('plan_empty')}</div>`;
  else if (!buy.length) html += `<div class="all-good">${t('all_good')}</div>`;
  else {
    const groups = new Map();
    for (const r of buy) {
      const key = r.ing.store || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || collator.compare(a, b));
    const showHeads = keys.some(Boolean);
    for (const key of keys) {
      if (showHeads) html += `<div class="store-head">${key ? '🏪 ' + esc(key) : t('no_store')}</div>`;
      html += `<ul class="list">${groups.get(key).map((r) => {
        const checked = !!checks()[r.ing.id];
        const u = U(r.ing.unit);
        const date = dates && dates.get(r.ing.id);
        return `<li class="row tap buy-row ${checked ? 'checked' : ''}" data-action="toggle-check" data-id="${r.ing.id}">
          <span class="check"></span>
          <div class="row-main">
            <div class="row-title">${esc(r.ing.name)} ${r.ing.perishable ? `<span class="tag warn-tag">${date ? t('by_date', { d: fmtDateShort(date) }) : t('perishable_tag')}</span>` : ''}</div>
            <div class="row-sub">${t('need')} ${fmt(r.need)} ${u} · ${t('home')} ${fmt(r.stock)}${r.ing.packs.length ? ` · ${t('left')} ${fmt(r.leftover)}` : ''}</div>
            ${r.ing.packs.length ? '' : `<div class="row-sub warn">${t('no_pack_warn')}</div>`}
          </div>
          <div class="row-side">
            ${r.combo.length ? r.combo.map((c) => `<div class="packs">${packLabel(r.ing, c.pack)} × ${c.n}</div>`).join('') : `<div class="packs">${fmt(r.buyAmount)} ${u}</div>`}
            ${r.cost ? `<div class="cost">${money(r.cost)}${r.costPartial ? '*' : ''}</div>` : ''}
          </div>
        </li>`;
      }).join('')}</ul>`;
    }
  }
  if (total > 0 || value > 0) {
    html += `<div class="totals">
      ${total > 0 ? `<div><span>${t('purchase_total')}</span><b>${money(total)}${totalPartial ? '*' : ''}</b></div>` : ''}
      ${value > 0 ? `<div><span>${t('production_cost')}</span><b>${money(value)}${valuePartial ? '*' : ''}</b></div>` : ''}
      ${totalPartial || valuePartial ? `<small>${t('no_price_note')}</small>` : ''}
    </div>`;
  }
  if (small.length) {
    html += `<details class="enough"><summary>${t('small_short', { n: small.length })}</summary>
      <ul class="list">${small.map((r) => `
        <li class="row"><div class="row-main"><div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub warn">${t('short_by', { v: `${fmt(r.deficit)} ${U(r.ing.unit)}` })}</div></div></li>`).join('')}
      </ul></details>`;
  }
  if (enough.length) {
    html += `<details class="enough"><summary>${t('enough', { n: enough.length })}</summary>
      <ul class="list">${enough.map((r) => `
        <li class="row"><div class="row-main"><div class="row-title">${esc(r.ing.name)}</div>
          <div class="row-sub">${t('need')} ${fmt(r.need)} ${U(r.ing.unit)} ${t('of')} ${fmt(r.stock)} · ${t('left')} ${fmt(r.leftover)}</div></div></li>`).join('')}
      </ul></details>`;
  }
  if (items.length) {
    html += `<div class="btn-stack">
      ${buy.length ? `<button type="button" class="btn secondary" data-action="share-list">${t('share_list')}</button>` : ''}
      ${buy.length ? `<button type="button" class="btn" data-action="bought">${t('bought')}</button>` : ''}
      ${all ? '' : `<button type="button" class="btn plain" data-action="baked">${t('baked')}</button>
      <button type="button" class="btn danger" data-action="clear-plan">${t('clear_plan')}</button>`}
    </div>`;
  }
  return html;
}

function shoppingText() {
  const all = state.activePlan === 'all';
  const p = getPlan(state.activePlan);
  const rows = calcRows(currentItems()).filter((r) => r.buyAmount > EPS);
  const groups = new Map();
  for (const r of rows) {
    const k = r.ing.store || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  // Весь текст — на языке «Список покупок для отправки».
  const S = L('share');
  const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || collator.compare(a, b));
  const lines = [];
  for (const k of keys) {
    if (keys.some(Boolean)) lines.push(`\n${k ? '🏪 ' + k : tL(S, 'no_store')}`);
    const list = groups.get(k).sort((a, b) => collator.compare(nameIn(a.ing, S), nameIn(b.ing, S)));
    for (const r of list) {
      const u = U(r.ing.unit, S);
      const what = r.combo.length
        ? r.combo.map((c) => `${nameIn(c.pack, S) || tL(S, 'pack_short')} ${fmt(c.pack.size)} ${u} × ${c.n}`).join(' + ')
        : `${fmt(r.buyAmount)} ${u}`;
      lines.push(`• ${nameIn(r.ing, S)} — ${what}`);
    }
  }
  const total = rows.reduce((s, r) => s + r.cost, 0);
  const date = p && validDate(p.date)
    ? new Intl.DateTimeFormat(LANGS[S].locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(toDate(p.date)) : '';
  const title = all ? tL(S, 'all_plans_title') : `${p.name || tL(S, 'plan_default')}${date ? ', ' + date : ''}`;
  return `${tL(S, 'share_header')} (${title})\n${lines.join('\n')}${total > 0 ? `\n\n${tL(S, 'purchase_total')}: ${fmt(total)} ${cur()}` : ''}`;
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

/** «Купила»: можно поправить, сколько и каких упаковок купила на самом деле. */
function boughtSheet() {
  const rows = calcRows(currentItems()).filter((r) => r.buyAmount > EPS);
  const someChecked = rows.some((r) => checks()[r.ing.id]);
  const list = someChecked ? rows.filter((r) => checks()[r.ing.id]) : rows;
  const el = openSheet(`
    ${sheetHead(t('bought_title'))}
    <div class="sheet-body">
      <p class="muted small-text hint-line">${someChecked ? t('bought_hint_checked', { n: list.length, total: rows.length }) : t('bought_hint')}</p>
      ${list.map((r) => `<div class="card buy-edit" data-id="${r.ing.id}">
        <div class="row-title">${esc(r.ing.name)}</div>
        ${r.ing.packs.length ? r.ing.packs.map((p) => {
          const c = r.combo.find((x) => x.pack.id === p.id);
          return `<div class="pack-line"><span>${packLabel(r.ing, p)}</span>${stepperHtml(`data-pack="${p.id}"`, c ? c.n : 0)}</div>`;
        }).join('') : `<div class="pack-line"><span>${t('amount')}, ${U(r.ing.unit)}</span>${stepperHtml('data-amount', round(r.buyAmount, 2))}</div>`}
      </div>`).join('')}
    </div>`, { guard: true });
  bindSteppers(el);
  $('[data-save]', el).onclick = guarded(() => {
    const adds = [];
    $$('.buy-edit', el).forEach((card) => {
      const ing = getIng(card.dataset.id);
      let add = 0;
      $$('[data-pack]', card).forEach((inp) => {
        const p = ing.packs.find((x) => x.id === inp.dataset.pack);
        add += Math.round(readNum(inp)) * p.size;
      });
      const a = $('[data-amount]', card);
      if (a) add += readNum(a);
      adds.push([ing, add]);
    });
    adds.forEach(([ing, add]) => {
      ing.stock = round(ing.stock + add);
      delete checks()[ing.id];
    });
    save();
    closeSheet(el);
    render();
    toast(t('stock_updated'));
  });
}

/** «Испекла» по одному рецепту: можно указать часть партий. */
function bakeSheet(recipeId) {
  const p = getPlan(state.activePlan);
  const it = p && p.items.find((x) => x.recipeId === recipeId);
  const r = getRec(recipeId);
  if (!it || !r) return;
  const el = openSheet(`
    ${sheetHead(t('bake_title'))}
    <div class="sheet-body">
      <div class="card">
        <div class="row-title">${esc(r.name)}</div>
        <div class="pack-line"><span>${t('bake_how_many', { n: fmt(it.count) })}</span>${stepperHtml('data-count', it.count)}</div>
      </div>
      <p class="muted small-text hint-line">${t('bake_note')}</p>
    </div>`);
  bindSteppers(el);
  $('[data-save]', el).onclick = guarded(() => {
    const n = Math.min(it.count, readNum($('[data-count]', el), { required: true, positive: true }));
    // Списываем разницу «до» и «после», чтобы штучное (яйца) не округлялось вверх при каждой
    // частичной выпечке: 0,5 + 0,5 бисквита на 3 яйца = 3 яйца, а не 4.
    const before = needsFor([it]);
    const after = needsFor([{ ...it, count: Math.max(0, it.count - n) }]);
    const spend = new Map([...before].map(([k, v]) => [k, Math.max(0, v - (after.get(k) || 0))]));
    const short = deduct(spend);
    it.count = round(it.count - n, 2);
    if (it.count <= EPS) p.items = p.items.filter((x) => x !== it);
    save();
    closeSheet(el);
    render();
    toast(short.length ? t('baked_short_toast', { list: short.join(', ') }) : t('baked_done'));
  });
}

function bakeAll() {
  const p = getPlan(state.activePlan);
  if (!p) return;
  const need = needsFor(p.items);
  const short = [...need].filter(([id, n]) => getIng(id) && getIng(id).stock < n - EPS).map(([id]) => getIng(id).name);
  let msg = t('baked_confirm');
  if (short.length) msg += t('baked_short', { list: short.join(', ') });
  if (!confirm(msg)) return;
  deduct(need);
  p.items = [];
  delete state.checked[p.id];
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
      <button type="button" class="nav-row" data-action="languages">
        <span><b>${t('languages')}</b><small>${langSummary()}</small></span><span class="chev">›</span>
      </button>
      <label class="field"><span>${t('currency')}</span>
        <input id="currency" value="${esc(cur())}" maxlength="5" autocomplete="off"></label>
      <label class="field" style="margin:0"><span>${t('tolerance')}</span>
        <input id="tolerance" inputmode="decimal" value="${inVal(state.settings.tolerance || 0)}" autocomplete="off">
        <div class="note">${t('tolerance_note')}</div></label>
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
    <div class="card small-text muted">${t('data_counts', { i: state.ingredients.length, r: state.recipes.length, p: state.plans.length })}</div>
    <div class="btn-stack">
      <button type="button" class="btn plain" data-action="demo">${t('demo')}</button>
      <button type="button" class="btn danger" data-action="reset">${t('reset')}</button>
    </div>
    <p class="muted small-text" style="text-align:center;margin-top:24px">${t('version', { v: VERSION })}</p>`;
}

/* ---------- Языки ---------- */
/** Короткая сводка для строки «Языки»: «Русский» или «Интерфейс: Русский · Ингредиенты: Polski…». */
function langSummary() {
  const vals = LANG_CATS.map(L);
  if (vals.every((v) => v === vals[0])) return LANGS[vals[0]].name;
  return LANG_CATS.filter((c) => c === 'ui' || L(c) !== L('ui')).map((c) => `${t('lang_' + c)}: ${LANGS[L(c)].name}`).join(' · ');
}
/** Сколько названий без перевода на какой-нибудь язык. */
function missingCounts() {
  const custom = state.ingredients.flatMap((i) => i.packs.filter((p) => p.type === 'custom' && allNames(p).length));
  return {
    i: state.ingredients.filter((x) => missingLangs(x).length).length,
    r: state.recipes.filter((x) => missingLangs(x).length).length,
    p: custom.filter((x) => missingLangs(x).length).length,
  };
}
/** Заполняет недостающие переводы из словаря. Возвращает, сколько названий подставлено. */
function autoTranslate() {
  let n = 0;
  const fill = (o) => {
    for (const c of missingLangs(o)) {
      for (const from of LANG_CODES) {
        const g = o.names[from] && guessName(o.names[from], from, c);
        if (g) { o.names[c] = g; n++; break; }
      }
    }
  };
  state.ingredients.forEach((i) => { fill(i); i.packs.filter((p) => p.type === 'custom' && allNames(p).length).forEach(fill); });
  state.recipes.forEach(fill);
  return n;
}

function languagesPage() {
  const el = openSheet('');
  const seg = (cat, active) => `<div class="segmented">${LANG_CODES.map((c) =>
    `<button type="button" data-cat="${cat}" data-lang="${c}" class="${c === active ? 'active' : ''}">${LANGS[c].name}</button>`).join('')}</div>`;
  const draw = () => {
    const vals = LANG_CATS.map(L);
    const same = vals.every((v) => v === vals[0]) ? vals[0] : null;
    const m = missingCounts();
    $('.sheet', el).innerHTML = `
      <div class="sheet-head"><span></span><h2>${t('languages')}</h2><button type="button" class="primary" data-close>${t('done')}</button></div>
      <div class="sheet-body">
        <div class="card"><div class="field" style="margin:0"><span>${t('lang_all')}</span>${seg('all', same)}</div></div>
        <div class="card lang-list">${LANG_CATS.map((cat) => `
          <div class="lang-row">
            <div class="lang-label"><b>${t('lang_' + cat)}</b><small>${t('lang_' + cat + '_note')}</small></div>
            ${seg(cat, L(cat))}
          </div>`).join('')}</div>
        <p class="muted small-text hint-line">${t('lang_fallback_note')}</p>
        <div class="section-title"><span>${t('translations')}</span></div>
        <div class="card">
          <p class="small-text">${m.i || m.r || m.p ? t('translations_missing', m) : t('translations_all_done')}</p>
          ${m.i || m.r || m.p ? `<div class="btn-stack">
            <button type="button" class="btn secondary" data-auto>${t('translate_auto')}</button>
            <button type="button" class="btn plain" data-translations>${t('translations_btn')}</button>
          </div>` : ''}
        </div>
      </div>`;
    $$('[data-close]', el).forEach((b) => (b.onclick = () => closeSheet(el)));
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) {
      const cats = b.dataset.cat === 'all' ? LANG_CATS : [b.dataset.cat];
      cats.forEach((c) => (state.settings.langs[c] = b.dataset.lang));
      save();
      applyLocale();
      render();
      draw();
      return;
    }
    if (e.target.closest('[data-auto]')) {
      const n = autoTranslate();
      save();
      render();
      draw();
      toast(n ? t('translate_auto_done', { n }) : t('translate_auto_none'));
    }
    if (e.target.closest('[data-translations]')) translationsSheet(draw);
  });
  draw();
}

/** Экран быстрого заполнения переводов: всё, у чего нет названия на каком-то языке. */
function translationsSheet(onClose) {
  const custom = [];
  state.ingredients.forEach((i) => i.packs.forEach((p) => {
    if (p.type === 'custom' && allNames(p).length && missingLangs(p).length) custom.push({ o: p, label: `${i.name} · ${fmt(p.size)} ${U(i.unit)}` });
  }));
  const groups = [
    ['ingredients_section', state.ingredients.filter((x) => missingLangs(x).length).sort(byName).map((o) => ({ o }))],
    ['recipes_section', state.recipes.filter((x) => missingLangs(x).length).sort(byName).map((o) => ({ o }))],
    ['packs_section', custom],
  ].filter(([, list]) => list.length);
  const all = groups.flatMap(([, list]) => list.map((x) => x.o));
  const el = openSheet(`
    <div class="sheet-head"><span></span><h2>${t('translations')}</h2><button type="button" class="primary" data-close>${t('done')}</button></div>
    <div class="sheet-body">
      <p class="muted small-text hint-line">${t('translations_hint')}</p>
      ${groups.map(([title, list]) => `
        <div class="section-title"><span>${t(title)}</span></div>
        ${list.map((x) => `<div class="card tr-card" data-k="${all.indexOf(x.o)}">
          ${x.label ? `<div class="row-sub">${esc(x.label)}</div>` : ''}
          <div class="names2">${LANG_CODES.map((c) => `
            <label class="lang-input"><b>${c.toUpperCase()}</b>
              <input data-lang="${c}" value="${esc(x.o.names[c] || '')}" class="${x.o.names[c] ? '' : 'missing'}" autocomplete="off"></label>`).join('')}</div>
        </div>`).join('')}`).join('')}
    </div>`);
  el.addEventListener('change', (e) => {
    const card = e.target.closest('.tr-card');
    if (!card) return;
    const o = all[+card.dataset.k];
    const v = e.target.value.trim().slice(0, 100);
    if (!v && allNames(o).filter((n) => n !== o.names[e.target.dataset.lang]).length === 0) {
      e.target.value = o.names[e.target.dataset.lang] || '';
      return toast(t('name_required'));
    }
    if (v) o.names[e.target.dataset.lang] = v; else delete o.names[e.target.dataset.lang];
    e.target.classList.toggle('missing', !v);
    e.target.classList.add('saved');
    setTimeout(() => e.target.classList.remove('saved'), 800);
    save();
    render();
  });
  $$('[data-close]', el).forEach((b) => (b.onclick = () => { closeSheet(el); if (onClose) onClose(); }));
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

function importText(text) {
  let s;
  try { s = JSON.parse(text); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || !Array.isArray(s.ingredients) || !Array.isArray(s.recipes)) {
    alert(t('import_failed'));
    return false;
  }
  const clean = sanitize(s);
  if (!confirm(t('import_confirm', { i: clean.ingredients.length, r: clean.recipes.length, p: clean.plans.length }))) return false;
  if (!s.settings || (!s.settings.lang && !s.settings.langs)) clean.settings.langs = { ...state.settings.langs };
  state = clean;
  save();
  applyLocale();
  render();
  toast(t('restored'));
  return true;
}
function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const f = input.files[0];
    if (f) importText(await f.text());
  };
  input.click();
}

function loadDemo() {
  if ((state.ingredients.length || state.recipes.length) && !confirm(t('demo_confirm'))) return;
  // Пример сразу на обоих языках; упаковки — встроенные типы.
  const both = (get) => Object.fromEntries(LANG_CODES.map((c) => [c, get(tL(c, 'demo_data'))]));
  const D = t('demo_data');
  const P = (size, price, type) => ({ id: uid(), size, price, type });
  const I = (k, unit, packs, stock, store, extra = {}) => ({ id: uid(), names: both((d) => d[k]), unit, packs, stock, store, perishable: false, pieceWeight: 0, ...extra });
  const ings = {
    flour: I('flour', 'г', [P(1000, 4, 'bag')], 1500, 'Biedronka'),
    sugar: I('sugar', 'г', [P(1000, 4.5, 'pack')], 800, 'Biedronka'),
    butter: I('butter', 'г', [P(200, 7.5, 'cube'), P(1000, 32, 'block')], 400, 'Biedronka'),
    eggs: I('eggs', 'шт', [P(10, 11, 'tray'), P(30, 30, 'tray')], 6, 'Biedronka', { pieceWeight: 60 }),
    cream: I('cream', 'мл', [P(500, 12, 'carton')], 0, 'Makro', { perishable: true }),
    cheese: I('cheese', 'г', [P(250, 9, 'box'), P(1000, 32, 'box')], 0, 'Makro', { perishable: true }),
    honey: I('honey', 'г', [P(400, 22, 'jar')], 200, 'Biedronka'),
    soda: I('soda', 'г', [P(70, 1.5, 'sachet')], 60, 'Biedronka'),
    choc: I('choc', 'г', [P(100, 6, 'bar'), P(1000, 45, 'bag')], 0, 'Makro'),
  };
  const R = (k, extra, items) => ({
    id: uid(), names: both((d) => d[k][0]), note: D[k][1], isPrep: false, yieldWeight: 0, baseDiameter: 0, loss: 0, ...extra,
    items: items.map(([ik, qty, u]) => (ik.startsWith('@') ? { recId: recs[ik.slice(1)].id, qty, u: u || 'batch' } : { ingId: ings[ik].id, qty, u: u || ings[ik].unit })),
  });
  const recs = {};
  recs.cream = R('r3', { isPrep: true, yieldWeight: 850, loss: 5 }, [['cream', 300], ['cheese', 500], ['sugar', 80]]);
  recs.honey = R('r1', { baseDiameter: 22 }, [['flour', 500], ['sugar', 250], ['butter', 100], ['eggs', 3], ['honey', 100], ['soda', 5], ['@cream', 1]]);
  recs.cookies = R('r2', {}, [['flour', 280], ['sugar', 200], ['butter', 170], ['eggs', 100, 'г'], ['choc', 200], ['soda', 5]]);
  const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const plan = { id: uid(), name: D.plan, date: in3, items: [{ recipeId: recs.honey.id, count: 1, diameter: 24 }, { recipeId: recs.cookies.id, count: 2, diameter: 0 }] };
  state = sanitize({
    v: 2, ingredients: Object.values(ings), recipes: Object.values(recs), plans: [plan], activePlan: plan.id, settings: state.settings,
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
  const plan = getPlan(state.activePlan);
  switch (a.dataset.action) {
    case 'new-ing': return editIngredient();
    case 'edit-ing': return editIngredient(id);
    case 'toggle-inv': invMode = !invMode; return render();
    case 'new-rec': return editRecipe();
    case 'edit-rec': return editRecipe(id);
    case 'goto-recipes': return setTab('recipes');
    case 'goto-ingredients': return setTab('ingredients');
    case 'new-plan': return editPlan();
    case 'edit-plan': return editPlan(id);
    case 'select-plan':
      state.activePlan = id;
      save();
      return render();
    case 'add-to-plan': {
      const add = (target) => {
        const p = addToPlan(id, 1, target);
        render();
        toast(t('added_to_plan', { name: getRec(id).name, n: fmt(p.items.find((x) => x.recipeId === id).count), plan: planTitle(p) }));
      };
      // В режиме «Все» спрашиваем, в какой план добавить, и не выключаем режим.
      if (state.activePlan === 'all' && state.plans.length > 1) return choosePlan(add);
      return add(targetPlan());
    }
    case 'plan-inc': addToPlan(id, 1, plan); return render();
    case 'plan-dec': {
      const it = plan.items.find((x) => x.recipeId === id);
      if (it && it.count <= 1 + EPS && !confirm(t('remove_from_plan', { name: getRec(id).name }))) return;
      addToPlan(id, it && it.count < 1 ? -it.count : -1, plan);
      return render();
    }
    case 'bake-one': return bakeSheet(id);
    case 'toggle-check':
      { const ch = checks(); if (ch[id]) delete ch[id]; else ch[id] = true; }
      save();
      return a.classList.toggle('checked', !!checks()[id]);
    case 'share-list': return shareList();
    case 'bought': return boughtSheet();
    case 'baked': return bakeAll();
    case 'clear-plan':
      if (!confirm(t('clear_plan_confirm'))) return;
      plan.items = []; delete state.checked[plan.id]; save(); return render();
    case 'languages': return languagesPage();
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
  const plan = getPlan(state.activePlan);
  if (el.matches('#view [data-plan-count]') && plan) {
    const it = plan.items.find((x) => x.recipeId === el.dataset.id);
    const v = num(el.value);
    if (!it) return;
    if (!Number.isFinite(v) || v < 0) { el.value = inVal(it.count); return toast(t('bad_number')); }
    if (v <= EPS) plan.items = plan.items.filter((x) => x !== it);
    else it.count = round(v, 2);
    save();
    render();
  }
  if (el.matches('#view [data-plan-dia]') && plan) {
    const it = plan.items.find((x) => x.recipeId === el.dataset.id);
    const v = el.value.trim() ? num(el.value) : 0;
    if (!it) return;
    if (!Number.isFinite(v) || v < 0) { el.value = inVal(it.diameter || ''); return toast(t('bad_number')); }
    it.diameter = v;
    save();
    render();
  }
  if (el.matches('#view [data-stock]')) {
    const ing = getIng(el.dataset.id);
    const v = el.value.trim() ? num(el.value) : 0;
    if (!Number.isFinite(v) || v < 0) { el.classList.add('invalid'); return toast(t('bad_number')); }
    el.classList.remove('invalid');
    ing.stock = v;
    save();
    el.classList.add('saved');
    setTimeout(() => el.classList.remove('saved'), 800);
  }
  if (el.id === 'currency') {
    state.settings.currency = el.value.trim() || 'zł';
    save();
    toast(t('currency_saved'));
  }
  if (el.id === 'tolerance') {
    const v = el.value.trim() ? num(el.value) : 0;
    if (!Number.isFinite(v) || v < 0 || v > 100) { el.value = inVal(state.settings.tolerance); return toast(t('bad_number')); }
    state.settings.tolerance = v;
    save();
    toast(t('settings_saved'));
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
