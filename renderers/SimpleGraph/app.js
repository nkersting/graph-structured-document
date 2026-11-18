/* SimpleGraph — a minimal, dependency-free graph navigator for Graph Structured Documents (knowledge.json).
 *
 * The whole graph is drawn on a canvas with a force-directed layout (pan, zoom, drag nodes).
 * Clicking a node shows its description, hints, links and content widgets on the right;
 * clicking a widget opens it with its embedded image. The detail panel matches SimpleTree.
 */
(() => {
  'use strict';

  const SEARCH_LIMIT = 300;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };

  const state = {
    doc: null,
    sourceName: '',
    nodes: new Map(),      // id -> node
    out: new Map(),        // id -> [{id, weight, relation, extra}]
    inc: new Map(),        // id -> [{id, weight, relation, extra}]
    children: new Map(),   // tree children
    parent: new Map(),     // tree parent
    roots: [],
    selected: null,
    widgetList: [],        // widgets of the selected node (for modal prev/next)
  };

  // ---------------------------------------------------------------- settings

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  let imageBase = store.get('simple.imageBase', '');
  if (imageBase === '../DynamicTree/public') imageBase = ''; // old default from an earlier version; use auto-detection
  $('imageBase').value = imageBase;
  $('imageBase').placeholder = 'auto (../DynamicTree/public)';
  let docUrl = null;        // absolute URL of the loaded document, if loaded over http
  $('imageBase').addEventListener('change', (e) => {
    imageBase = e.target.value.trim();
    store.set('simple.imageBase', imageBase);
    if (state.selected) showNode(state.selected, { keepScroll: true });
  });
  $('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });

  // ---------------------------------------------------------------- images

  /** Candidate URLs for an image path; relative/root paths also get tried under imageBase. */
  function imageBases() {
    const bases = [];
    const add = (b, rel) => { try { bases.push(new URL(b.replace(/\/*$/, '/'), rel || location.href).href); } catch { /* bad URL */ } };
    if (imageBase) add(imageBase);
    if (docUrl) { add('./', docUrl); add('../', docUrl); }
    add('../DynamicTree/public/'); add('../../renderers/DynamicTree/public/');
    return bases;
  }

  function imageCandidates(p) {
    if (!p || typeof p !== 'string') return [];
    p = p.trim();
    if (/^(https?:|data:|blob:|\/\/)/i.test(p)) return [p];
    const rel = p.replace(/^\.?\/+/, '');
    const list = [];
    for (const b of imageBases()) { try { list.push(new URL(rel, b).href); } catch { /* skip */ } }
    try { list.push(new URL(p, location.href).href); } catch { /* skip */ }
    return [...new Set(list)];
  }

  /** The image to show for a node: its own icon, else the first widget image. */
  function nodeImage(n) {
    if (n.icon) return n.icon;
    for (const w of Array.isArray(n.content) ? n.content : []) { const s = wProps(w).icon || w.icon; if (s) return s; }
    return null;
  }

  /** <img> that walks through candidates on error, then calls onFail. */
  function smartImg(path, attrs = {}, onFail) {
    const cands = imageCandidates(path);
    if (!cands.length) { onFail && onFail(null); return null; }
    // no-referrer: some image hosts refuse hotlinked requests that carry a localhost referrer.
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: '', referrerpolicy: 'no-referrer', ...attrs });
    let i = 0;
    img.addEventListener('error', () => {
      i += 1;
      if (i < cands.length) img.src = cands[i];
      else if (onFail) onFail(img);
      else img.style.visibility = 'hidden';
    });
    img.src = cands[0];
    return img;
  }

  // ---------------------------------------------------------------- loading

  async function loadFromUrl(url, label) {
    setStatus(`Loading ${label || url}…`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      docUrl = new URL(url, location.href).href;
      loadText(text, label || url.split('/').pop());
      const u = new URL(location.href);
      u.searchParams.set('file', url);
      history.replaceState(null, '', u);
    } catch (err) {
      setStatus(`Could not load ${label || url}: ${err.message}`, true);
    }
  }

  function loadFile(file) {
    setStatus(`Reading ${file.name}…`);
    const r = new FileReader();
    r.onload = () => {
      docUrl = null;
      loadText(String(r.result), file.name);
      const u = new URL(location.href);
      u.searchParams.delete('file'); u.hash = '';
      history.replaceState(null, '', u);
    };
    r.onerror = () => setStatus(`Could not read ${file.name}`, true);
    r.readAsText(file);
  }

  function loadText(text, name) {
    let doc;
    try { doc = JSON.parse(text); } catch (err) { setStatus(`${name} is not valid JSON: ${err.message}`, true); return; }
    if (!doc || !doc.graph || !Array.isArray(doc.graph.nodes)) {
      setStatus(`${name} doesn't look like a knowledge.json (no graph.nodes).`, true); return;
    }
    state.sourceName = name;
    build(doc);
  }

  function setStatus(msg, isError) {
    $('docSub').textContent = msg;
    $('docSub').style.color = isError ? '#c0392b' : '';
  }

  // ---------------------------------------------------------------- graph

  function build(doc) {
    state.doc = doc;
    state.nodes = new Map();
    state.out = new Map(); state.inc = new Map();
    state.children = new Map(); state.parent = new Map();
    state.roots = []; state.selected = null;

    const g = doc.graph;
    for (const n of g.nodes) if (n && n.id != null) state.nodes.set(String(n.id), n);

    const addEdge = (s, t, v = {}) => {
      s = String(s); t = String(t);
      if (!state.nodes.has(s) || !state.nodes.has(t)) return;
      const info = (v && typeof v === 'object') ? v : { weight: v };
      const { weight, relation, ...extra } = info;
      if (!state.out.has(s)) state.out.set(s, []);
      if (!state.inc.has(t)) state.inc.set(t, []);
      state.out.get(s).push({ id: t, weight, relation, extra });
      state.inc.get(t).push({ id: s, weight, relation, extra });
    };
    const E = g.edges;
    if (Array.isArray(E)) {
      for (const e of E) if (e) addEdge(e.source ?? e.from, e.target ?? e.to, e);
    } else if (E && typeof E === 'object') {
      for (const [s, targets] of Object.entries(E)) {
        if (Array.isArray(targets)) targets.forEach((t) => typeof t === 'object' ? addEdge(s, t.target ?? t.id, t) : addEdge(s, t));
        else if (targets && typeof targets === 'object') for (const [t, v] of Object.entries(targets)) addEdge(s, t, v);
      }
    }

    // Breadth-first spanning tree from the root, then from any node left over.
    const seen = new Set();
    const bfs = (start) => {
      state.roots.push(start); seen.add(start);
      const q = [start];
      for (let qi = 0; qi < q.length; qi++) {
        const id = q[qi];
        const kids = [];
        for (const e of state.out.get(id) || []) {
          if (seen.has(e.id)) continue;
          seen.add(e.id); state.parent.set(e.id, id); kids.push(e.id); q.push(e.id);
        }
        state.children.set(id, kids);
      }
    };
    const rootId = g.rootNodeId != null && state.nodes.has(String(g.rootNodeId)) ? String(g.rootNodeId) : null;
    if (rootId) bfs(rootId);
    for (const id of state.nodes.keys()) if (!seen.has(id) && !(state.inc.get(id) || []).length) bfs(id);
    for (const id of state.nodes.keys()) if (!seen.has(id)) bfs(id); // cycles with no entry point

    // Header
    const d = doc.document || {};
    const title = d.title || d.meta?.pagetitle || state.nodes.get(state.roots[0])?.name || state.sourceName;
    $('docTitle').textContent = title;
    document.title = `${title} — SimpleGraph`;
    const nEdges = [...state.out.values()].reduce((a, l) => a + l.length, 0);
    const nWidgets = [...state.nodes.values()].reduce((a, n) => a + (Array.isArray(n.content) ? n.content.length : 0), 0);
    setStatus([state.sourceName, d.description].filter(Boolean).join(' · '));
    $('nodeCount').textContent = `${fmt(state.nodes.size)} nodes · ${fmt(nEdges)} edges · ${fmt(nWidgets)} widgets`;

    $('search').disabled = false; $('search').value = '';
    $('results').hidden = true;
    $('graphEmpty').hidden = true;

    initGraph();
    const fromHash = decodeURIComponent((location.hash.match(/node=([^&]+)/) || [])[1] || '');
    const first = state.nodes.has(fromHash) ? fromHash : state.roots[0];
    if (first) select(first);
  }

  const fmt = (n) => n.toLocaleString();
  const nodeName = (n) => (n && (n.name || n.title)) || '(untitled)';

  function pathTo(id) {
    const path = [];
    for (let cur = id, guard = 0; cur != null && guard < 100000; cur = state.parent.get(cur), guard++) path.unshift(cur);
    return path;
  }

  // ---------------------------------------------------------------- graph view
  //
  // Force-directed layout on a <canvas>: Barnes–Hut repulsion, spring links, weak centering.
  // It starts from a radial layout of the BFS tree, so it settles quickly even for ~10k nodes.

  const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
  const THETA2 = 0.81;             // Barnes–Hut opening criterion (theta = 0.9), squared
  const LINK_DIST = 34;
  const ALPHA_MIN = 0.002;
  const VELOCITY_KEEP = 0.6;

  const canvas = $('graph');
  const ctx = canvas.getContext('2d');
  const G = {
    N: 0, ids: [], index: new Map(),
    x: null, y: null, vx: null, vy: null, r: null, depth: null, hasWidgets: null, fixed: null,
    links: null, M: 0, deg: null, bias: null, strength: null,
    charge: -40, alpha: 0, alphaDecay: 0, tickBudget: 12,
    k: 1, tx: 0, ty: 0, userMoved: false,
    hover: -1, sel: -1, neighbors: new Set(),
    w: 0, h: 0, dpr: 1,
    anim: null, frameQueued: false,
  };

  function initGraph() {
    const ids = [...state.nodes.keys()];
    const N = ids.length;
    G.N = N; G.ids = ids; G.index = new Map(ids.map((id, i) => [id, i]));
    G.x = new Float64Array(N); G.y = new Float64Array(N);
    G.vx = new Float64Array(N); G.vy = new Float64Array(N);
    G.r = new Float64Array(N); G.depth = new Int32Array(N);
    G.hasWidgets = new Uint8Array(N); G.fixed = new Uint8Array(N);
    G.sel = -1; G.hover = -1; G.neighbors = new Set(); G.userMoved = false;

    // Unique undirected links for the layout (direction is kept in state.out/inc for display).
    const seen = new Set();
    const pairs = [];
    for (const [s, list] of state.out) {
      const a = G.index.get(s);
      for (const e of list) {
        const b = G.index.get(e.id);
        if (a === b) continue;
        const key = a < b ? a * N + b : b * N + a;
        if (seen.has(key)) continue;
        seen.add(key); pairs.push(a, b);
      }
    }
    G.links = Int32Array.from(pairs); G.M = pairs.length / 2;
    G.deg = new Float64Array(N);
    for (let l = 0; l < G.M; l++) { G.deg[G.links[2 * l]]++; G.deg[G.links[2 * l + 1]]++; }
    G.bias = new Float64Array(G.M); G.strength = new Float64Array(G.M);
    for (let l = 0; l < G.M; l++) {
      const a = G.links[2 * l], b = G.links[2 * l + 1];
      G.bias[l] = G.deg[a] / (G.deg[a] + G.deg[b]);
      G.strength[l] = 1 / Math.min(G.deg[a], G.deg[b]);
    }
    G.charge = N > 2000 ? -30 : N > 300 ? -45 : -90;
    // Big graphs: fewer, longer simulation bursts between redraws (the radial start is already close).
    G.alphaDecay = 1 - Math.pow(ALPHA_MIN, 1 / (N > 2000 ? 200 : 320));
    G.tickBudget = N > 2000 ? 40 : N > 500 ? 24 : 12;

    // Size from weight, depth from the BFS tree.
    const maxW = Math.max(1, ...[...state.nodes.values()].map((n) => +n.weight || 0));
    ids.forEach((id, i) => {
      const n = state.nodes.get(id);
      const w = Math.max(0, +n.weight || 0) / maxW;
      G.r[i] = 4 + 10 * Math.sqrt(w);
      G.hasWidgets[i] = Array.isArray(n.content) && n.content.length ? 1 : 0;
    });
    for (const root of state.roots) {
      const q = [root]; G.depth[G.index.get(root)] = 0;
      for (let qi = 0; qi < q.length; qi++) {
        const d = G.depth[G.index.get(q[qi])];
        for (const c of state.children.get(q[qi]) || []) { G.depth[G.index.get(c)] = d + 1; q.push(c); }
      }
    }

    radialLayout();
    G.alpha = 1;
    renderLegend();
    resize();
    fitView(false);
    schedule();
  }

  /** Initial positions: BFS tree laid out radially, angle shares proportional to leaf counts. */
  function radialLayout() {
    const leaves = new Map();
    const order = [];
    for (const r of state.roots) { const q = [r]; for (let i = 0; i < q.length; i++) { order.push(q[i]); for (const c of state.children.get(q[i]) || []) q.push(c); } }
    for (let i = order.length - 1; i >= 0; i--) {
      const kids = state.children.get(order[i]) || [];
      leaves.set(order[i], kids.length ? kids.reduce((a, c) => a + leaves.get(c), 0) : 1);
    }
    let maxDepth = 1;
    for (let i = 0; i < G.N; i++) maxDepth = Math.max(maxDepth, G.depth[i]);
    const ring = Math.min(90, (Math.sqrt(G.N) * 28) / maxDepth + 20);
    const total = state.roots.reduce((a, r) => a + leaves.get(r), 0);
    const stack = [];
    let a = 0;
    // Several roots: each root's subtree gets its own wedge, roots sit slightly off-centre.
    for (const r of state.roots) { const span = (2 * Math.PI * leaves.get(r)) / total; stack.push([r, a, a + span]); a += span; }
    const jitter = () => (Math.random() - 0.5) * 2;
    while (stack.length) {
      const [id, a0, a1] = stack.pop();
      const i = G.index.get(id);
      const d = G.depth[i] + (state.roots.length > 1 ? 0.5 : 0);
      const ang = (a0 + a1) / 2;
      G.x[i] = Math.cos(ang) * d * ring + jitter(); G.y[i] = Math.sin(ang) * d * ring + jitter();
      const kids = state.children.get(id) || [];
      const L = leaves.get(id);
      let s = a0;
      for (const c of kids) { const span = ((a1 - a0) * leaves.get(c)) / L; stack.push([c, s, s + span]); s += span; }
    }
  }

  // ---- simulation

  let qCap = 0, qx0, qy0, qs, qm, qsx, qsy, qpt, qch, qn;
  function ensureQuad(cap) {
    if (cap <= qCap) return;
    qCap = cap;
    qx0 = new Float64Array(cap); qy0 = new Float64Array(cap); qs = new Float64Array(cap);
    qm = new Float64Array(cap); qsx = new Float64Array(cap); qsy = new Float64Array(cap);
    qpt = new Int32Array(cap); qch = new Int32Array(cap * 4);
  }
  function newQuad(x0, y0, s) {
    if (qn >= qCap) { // grow
      const o = { qx0, qy0, qs, qm, qsx, qsy, qpt, qch }; const old = qCap;
      qCap = 0; ensureQuad(old * 2);
      qx0.set(o.qx0); qy0.set(o.qy0); qs.set(o.qs); qm.set(o.qm); qsx.set(o.qsx); qsy.set(o.qsy); qpt.set(o.qpt); qch.set(o.qch);
    }
    const q = qn++;
    qx0[q] = x0; qy0[q] = y0; qs[q] = s; qm[q] = 0; qsx[q] = 0; qsy[q] = 0; qpt[q] = -1;
    qch[4 * q] = qch[4 * q + 1] = qch[4 * q + 2] = qch[4 * q + 3] = -1;
    return q;
  }
  function buildQuadtree() {
    const { N, x, y } = G;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) { if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i]; }
    ensureQuad(Math.max(64, N * 3)); qn = 0;
    newQuad(minX - 1, minY - 1, Math.max(maxX - minX, maxY - minY) + 2);
    for (let i = 0; i < N; i++) {
      let q = 0, depth = 0;
      for (;;) {
        // every quad on the path gains the point's mass
        qm[q] += 1; qsx[q] += x[i]; qsy[q] += y[i];
        if (qpt[q] === -1 && qch[4 * q] === -1 && qch[4 * q + 1] === -1 && qch[4 * q + 2] === -1 && qch[4 * q + 3] === -1) { qpt[q] = i; break; }
        if (depth++ > 40) break; // coincident points: keep them lumped in this quad
        if (qpt[q] >= 0) { // split a leaf: push its point one level down
          const j = qpt[q]; qpt[q] = -2;
          const cj = childFor(q, x[j], y[j]);
          qm[cj] += 1; qsx[cj] += x[j]; qsy[cj] += y[j]; qpt[cj] = j;
        }
        q = childFor(q, x[i], y[i]);
      }
    }
  }
  function childFor(q, px, py) {
    const h = qs[q] / 2;
    const right = px >= qx0[q] + h ? 1 : 0, bottom = py >= qy0[q] + h ? 1 : 0;
    const slot = 4 * q + right + 2 * bottom;
    if (qch[slot] === -1) { const c = newQuad(qx0[q] + right * h, qy0[q] + bottom * h, h); qch[slot] = c; }
    return qch[slot];
  }

  const stackBuf = [];
  function tick() {
    const { N, x, y, vx, vy, alpha } = G;
    // repulsion
    buildQuadtree();
    const strength = G.charge * alpha;
    for (let i = 0; i < N; i++) {
      const xi = x[i], yi = y[i];
      let fx = 0, fy = 0;
      stackBuf.length = 0; stackBuf.push(0);
      while (stackBuf.length) {
        const q = stackBuf.pop();
        const m = qm[q]; if (!m) continue;
        const cx = qsx[q] / m, cy = qsy[q] / m;
        let dx = cx - xi, dy = cy - yi;
        let d2 = dx * dx + dy * dy;
        const leaf = qpt[q] >= 0;
        if (leaf || (qs[q] * qs[q]) / (d2 || 1e-9) < THETA2 || (qpt[q] === -2 && qch[4 * q] === -1 && qch[4 * q + 1] === -1 && qch[4 * q + 2] === -1 && qch[4 * q + 3] === -1)) {
          let mm = m;
          if (leaf && qpt[q] === i) continue;
          if (d2 === 0) { dx = (Math.random() - 0.5) * 1e-3; dy = (Math.random() - 0.5) * 1e-3; d2 = dx * dx + dy * dy; }
          if (d2 < 1) d2 = Math.sqrt(d2);
          const f = (strength * mm) / d2;
          fx += dx * f; fy += dy * f;
        } else {
          for (let c = 0; c < 4; c++) { const ch = qch[4 * q + c]; if (ch !== -1) stackBuf.push(ch); }
        }
      }
      vx[i] += fx; vy[i] += fy;
    }
    // links
    const L = G.links;
    for (let l = 0; l < G.M; l++) {
      const s = L[2 * l], t = L[2 * l + 1];
      let dx = x[t] + vx[t] - x[s] - vx[s], dy = y[t] + vy[t] - y[s] - vy[s];
      let d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const target = LINK_DIST + G.r[s] + G.r[t];
      d = ((d - target) / d) * alpha * G.strength[l];
      dx *= d; dy *= d;
      const b = G.bias[l];
      vx[t] -= dx * b; vy[t] -= dy * b;
      vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
    }
    // gentle pull to the centre keeps separate components together
    const pull = 0.03 * alpha;
    for (let i = 0; i < N; i++) {
      vx[i] -= x[i] * pull; vy[i] -= y[i] * pull;
      if (G.fixed[i]) { vx[i] = 0; vy[i] = 0; continue; }
      vx[i] *= VELOCITY_KEEP; vy[i] *= VELOCITY_KEEP;
      x[i] += vx[i]; y[i] += vy[i];
    }
    G.alpha += (0 - G.alpha) * G.alphaDecay;
  }

  // ---- view transform

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    G.dpr = window.devicePixelRatio || 1;
    G.w = rect.width; G.h = rect.height;
    canvas.width = Math.round(rect.width * G.dpr); canvas.height = Math.round(rect.height * G.dpr);
    canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
    schedule();
  }
  new ResizeObserver(() => { if (G.N) resize(); }).observe(canvas.parentElement);

  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < G.N; i++) {
      const r = G.r[i];
      minX = Math.min(minX, G.x[i] - r); maxX = Math.max(maxX, G.x[i] + r);
      minY = Math.min(minY, G.y[i] - r); maxY = Math.max(maxY, G.y[i] + r);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitView(animate = true) {
    if (!G.N || !G.w) return;
    const b = bounds(), pad = 40;
    const k = Math.min((G.w - 2 * pad) / Math.max(1, b.maxX - b.minX), (G.h - 2 * pad) / Math.max(1, b.maxY - b.minY), 2.5);
    const tx = G.w / 2 - k * (b.minX + b.maxX) / 2, ty = G.h / 2 - k * (b.minY + b.maxY) / 2;
    animateTo(k, tx, ty, animate ? 350 : 0);
  }

  function centerOn(i, minK = 1) {
    const k = Math.max(G.k, minK);
    animateTo(k, G.w / 2 - k * G.x[i], G.h / 2 - k * G.y[i], 450);
  }

  function zoomAt(sx, sy, factor, animate = false) {
    const k = Math.min(40, Math.max(0.01, G.k * factor));
    const wx = (sx - G.tx) / G.k, wy = (sy - G.ty) / G.k;
    animateTo(k, sx - wx * k, sy - wy * k, animate ? 200 : 0);
  }

  function animateTo(k, tx, ty, ms) {
    if (!ms) { G.anim = null; G.k = k; G.tx = tx; G.ty = ty; schedule(); return; }
    G.anim = { from: { k: G.k, tx: G.tx, ty: G.ty }, to: { k, tx, ty }, t0: performance.now(), ms };
    schedule();
  }

  // ---- drawing

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function schedule() {
    if (G.frameQueued) return;
    G.frameQueued = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    G.frameQueued = false;
    let again = false;
    if (G.alpha > ALPHA_MIN) {
      const t0 = performance.now();
      do tick(); while (G.alpha > ALPHA_MIN && performance.now() - t0 < G.tickBudget);
      if (!G.userMoved && !G.anim) fitView(false);
      again = G.alpha > ALPHA_MIN;
      $('layoutState').textContent = again ? 'laying out…' : '';
    }
    if (G.anim) {
      const a = G.anim, t = Math.min(1, (now - a.t0) / a.ms), e = 1 - Math.pow(1 - t, 3);
      // interpolate zoom in log space so it feels even
      G.k = Math.exp(Math.log(a.from.k) + (Math.log(a.to.k) - Math.log(a.from.k)) * e);
      const wx0 = (G.w / 2 - a.from.tx) / a.from.k, wy0 = (G.h / 2 - a.from.ty) / a.from.k;
      const wx1 = (G.w / 2 - a.to.tx) / a.to.k, wy1 = (G.h / 2 - a.to.ty) / a.to.k;
      const wx = wx0 + (wx1 - wx0) * e, wy = wy0 + (wy1 - wy0) * e;
      G.tx = G.w / 2 - wx * G.k; G.ty = G.h / 2 - wy * G.k;
      if (t >= 1) G.anim = null; else again = true;
    }
    draw();
    if (again) schedule();
  }

  function draw() {
    const { dpr, k, tx, ty, N, x, y, r } = G;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, G.w, G.h);
    if (!N) return;
    const ink = css('--ink'), accent = css('--accent'), panel = css('--panel'), line = css('--edge');
    const minR = 1.6 / k;

    ctx.save();
    ctx.translate(tx, ty); ctx.scale(k, k);

    // edges
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = line;
    ctx.beginPath();
    const L = G.links;
    for (let l = 0; l < G.M; l++) { const s = L[2 * l], t = L[2 * l + 1]; ctx.moveTo(x[s], y[s]); ctx.lineTo(x[t], y[t]); }
    ctx.stroke();

    // edges of the selected node, with direction
    if (G.sel >= 0) {
      const sid = G.ids[G.sel];
      ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 2 / k;
      const drawArrow = (a, b) => {
        const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d;
        const ex = x[b] - ux * (Math.max(r[b], minR) + 2 / k), ey = y[b] - uy * (Math.max(r[b], minR) + 2 / k);
        ctx.beginPath(); ctx.moveTo(x[a], y[a]); ctx.lineTo(ex, ey); ctx.stroke();
        const s = 7 / k;
        ctx.beginPath(); ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ux * s - uy * s * 0.5, ey - uy * s + ux * s * 0.5);
        ctx.lineTo(ex - ux * s + uy * s * 0.5, ey - uy * s - ux * s * 0.5);
        ctx.closePath(); ctx.fill();
      };
      for (const e of state.out.get(sid) || []) drawArrow(G.sel, G.index.get(e.id));
      for (const e of state.inc.get(sid) || []) drawArrow(G.index.get(e.id), G.sel);
    }

    // nodes, batched by colour; nodes without widgets are drawn as rings
    const vx0 = -tx / k, vy0 = -ty / k, vx1 = (G.w - tx) / k, vy1 = (G.h - ty) / k;
    const batches = new Map();
    for (let i = 0; i < N; i++) {
      const rr = Math.max(r[i], minR);
      if (x[i] + rr < vx0 || x[i] - rr > vx1 || y[i] + rr < vy0 || y[i] - rr > vy1) continue;
      const c = G.depth[i] === 0 ? accent : PALETTE[(G.depth[i] - 1) % PALETTE.length];
      const key = c + (G.hasWidgets[i] ? '|f' : '|o');
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(i);
    }
    for (const [key, list] of batches) {
      const [color, kind] = key.split('|');
      if (list.every((i) => r[i] * k < 2.5)) {
        // Zoomed far out: tiny squares are much cheaper than arcs and look the same.
        ctx.fillStyle = color;
        for (const i of list) { const rr = Math.max(r[i], minR); ctx.fillRect(x[i] - rr, y[i] - rr, 2 * rr, 2 * rr); }
        continue;
      }
      ctx.beginPath();
      for (const i of list) { const rr = Math.max(r[i], minR); ctx.moveTo(x[i] + rr, y[i]); ctx.arc(x[i], y[i], rr, 0, 2 * Math.PI); }
      if (kind === 'f') { ctx.fillStyle = color; ctx.fill(); }
      else { ctx.fillStyle = panel; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2 / k, 1.5); ctx.stroke(); }
    }

    // selection / hover rings
    const ring = (i, color, w) => {
      if (i < 0) return;
      ctx.beginPath(); ctx.arc(x[i], y[i], Math.max(r[i], minR) + 3 / k, 0, 2 * Math.PI);
      ctx.strokeStyle = color; ctx.lineWidth = w / k; ctx.stroke();
    };
    ring(G.hover, ink, 1.5);
    ring(G.sel, accent, 3);
    ctx.restore();

    drawLabels(ink, panel, css('--sans') || 'sans-serif');
  }

  function drawLabels(ink, panel, family) {
    const { k, tx, ty, N, x, y, r } = G;
    // priority: selected, hovered, neighbours of selected, then big nodes
    const want = [];
    const push = (i, bold) => { if (i >= 0) want.push([i, bold]); };
    push(G.sel, true); push(G.hover, true);
    for (const i of G.neighbors) push(i, false);
    const showAll = N <= 120;
    const big = [];
    for (let i = 0; i < N; i++) if (showAll || r[i] * k >= 7) big.push(i);
    big.sort((a, b) => r[b] - r[a]);
    for (const i of big.slice(0, 600)) push(i, false);

    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed = [];
    const seen = new Set();
    let count = 0;
    for (const [i, bold] of want) {
      if (seen.has(i)) continue; seen.add(i);
      const sx = x[i] * k + tx, sy = y[i] * k + ty;
      if (sx < -200 || sx > G.w + 50 || sy < -20 || sy > G.h + 20) continue;
      let label = nodeName(state.nodes.get(G.ids[i]));
      if (label.length > 40) label = label.slice(0, 38) + '…';
      ctx.font = `${bold ? 600 : 400} 12px ${family}`;
      const w = ctx.measureText(label).width;
      const lx = sx + Math.max(r[i] * k, 1.6) + 5, ly = sy;
      const box = [lx - 2, ly - 8, lx + w + 2, ly + 8];
      if (!bold && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      ctx.strokeStyle = panel; ctx.lineWidth = 3.5; ctx.strokeText(label, lx, ly);
      ctx.fillStyle = ink; ctx.fillText(label, lx, ly);
      if (++count > 400) break;
    }
  }

  function renderLegend() {
    let maxDepth = 0;
    for (let i = 0; i < G.N; i++) maxDepth = Math.max(maxDepth, G.depth[i]);
    const legend = $('legend');
    legend.replaceChildren(
      el('div', { class: 'lg-title', text: 'Colour = steps from root' }),
      el('div', { class: 'lg-row' },
        el('span', { class: 'dot', style: `background:${css('--accent')}` }), el('span', { text: 'root' }),
        ...PALETTE.slice(0, Math.min(maxDepth, PALETTE.length)).map((c, d) => [
          el('span', { class: 'dot', style: `background:${c}` }), el('span', { text: String(d + 1) + (d === PALETTE.length - 1 && maxDepth > PALETTE.length ? '…' : '') }),
        ])),
      el('div', { class: 'lg-row' },
        el('span', { class: 'dot' , style: `background:${PALETTE[0]}` }), el('span', { text: 'has widgets' }),
        el('span', { class: 'dot ring', style: `border-color:${PALETTE[0]}` }), el('span', { text: 'no widgets' })),
    );
  }

  // ---- interaction

  function toWorld(sx, sy) { return [(sx - G.tx) / G.k, (sy - G.ty) / G.k]; }

  function hitTest(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    let best = -1, bestD = Infinity;
    const slack = 4 / G.k, minR = 1.6 / G.k;
    for (let i = 0; i < G.N; i++) {
      const d = Math.hypot(G.x[i] - wx, G.y[i] - wy);
      if (d <= Math.max(G.r[i], minR) + slack && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!G.N) return;
    canvas.setPointerCapture(e.pointerId);
    const hit = hitTest(e.offsetX, e.offsetY);
    drag = { x: e.offsetX, y: e.offsetY, tx: G.tx, ty: G.ty, node: hit, moved: false };
    G.anim = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!G.N) return;
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; G.userMoved = true;
      canvas.classList.add('grabbing');
      if (drag.node >= 0) {
        const [wx, wy] = toWorld(e.offsetX, e.offsetY);
        G.x[drag.node] = wx; G.y[drag.node] = wy; G.fixed[drag.node] = 1;
        G.alpha = Math.max(G.alpha, 0.08);
      } else {
        G.tx = drag.tx + dx; G.ty = drag.ty + dy;
      }
      schedule();
      return;
    }
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit !== G.hover) {
      G.hover = hit;
      canvas.style.cursor = hit >= 0 ? 'pointer' : '';
      schedule();
    }
  });
  const endDrag = () => {
    if (!drag) return;
    if (!drag.moved && drag.node >= 0) select(G.ids[drag.node]);
    if (drag.node >= 0) G.fixed[drag.node] = 0;
    canvas.classList.remove('grabbing');
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { if (!drag && G.hover !== -1) { G.hover = -1; schedule(); } });
  canvas.addEventListener('wheel', (e) => {
    if (!G.N) return;
    e.preventDefault();
    G.userMoved = true;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.offsetX, e.offsetY, Math.exp(-dy * 0.0015));
  }, { passive: false });

  $('zoomIn').addEventListener('click', () => { G.userMoved = true; zoomAt(G.w / 2, G.h / 2, 1.5, true); });
  $('zoomOut').addEventListener('click', () => { G.userMoved = true; zoomAt(G.w / 2, G.h / 2, 1 / 1.5, true); });
  $('zoomFit').addEventListener('click', () => { G.userMoved = true; fitView(true); });
  $('relayout').addEventListener('click', () => { G.alpha = Math.max(G.alpha, 0.6); G.userMoved = false; schedule(); });

  canvas.addEventListener('keydown', (e) => {
    if (!$('modal').hidden || !G.N) return;
    const step = 60;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); G.userMoved = true; G.tx += moves[e.key][0]; G.ty += moves[e.key][1]; schedule(); }
    else if (e.key === '+' || e.key === '=') { G.userMoved = true; zoomAt(G.w / 2, G.h / 2, 1.3, true); }
    else if (e.key === '-' || e.key === '_') { G.userMoved = true; zoomAt(G.w / 2, G.h / 2, 1 / 1.3, true); }
    else if (e.key === '0') { G.userMoved = true; fitView(true); }
  });

  function setGraphSelection(id) {
    G.sel = G.index.has(id) ? G.index.get(id) : -1;
    G.neighbors = new Set();
    if (G.sel >= 0) {
      for (const e of state.out.get(id) || []) G.neighbors.add(G.index.get(e.id));
      for (const e of state.inc.get(id) || []) G.neighbors.add(G.index.get(e.id));
    }
    schedule();
  }

  // ---------------------------------------------------------------- selection / detail

  /** Select a node. `center` pans the graph to it (used when navigating from the panel or search). */
  function select(id, opts = {}) {
    if (!state.nodes.has(id)) return;
    state.selected = id;
    setGraphSelection(id);
    if (opts.center && G.index.has(id)) { G.userMoved = true; centerOn(G.index.get(id)); }
    showNode(id, opts);
    history.replaceState(null, '', `${location.pathname}${location.search}#node=${encodeURIComponent(id)}`);
  }

  function showNode(id, { keepScroll } = {}) {
    const n = state.nodes.get(id);
    const detail = $('detail');
    const prevScroll = detail.scrollTop;
    const inner = el('div', { class: 'detail-inner' });

    // Breadcrumbs
    const path = pathTo(id);
    if (path.length > 1) {
      const crumbs = el('nav', { class: 'crumbs' });
      const shown = path.length > 8 ? [path[0], null, ...path.slice(-6)] : path;
      shown.forEach((pid, i) => {
        if (i) crumbs.append(el('span', { text: '›' }));
        if (pid == null) crumbs.append(el('span', { text: '…' }));
        else if (pid === id) crumbs.append(el('span', { text: nodeName(n) }));
        else crumbs.append(el('button', { text: nodeName(state.nodes.get(pid)), onclick: () => select(pid, { center: true }) }));
      });
      inner.append(crumbs);
    }

    // Header
    const head = el('div', { class: 'node-head' });
    const heroSrc = nodeImage(n);
    if (heroSrc) {
      const hero = smartImg(heroSrc, { class: 'hero' }, (img) => img && img.remove());
      if (hero) {
        hero.addEventListener('click', () => (n.icon ? openImage(n.icon, nodeName(n)) : openWidget(0)));
        head.append(hero);
      }
    }
    const outs = state.out.get(id) || [];
    const ins = state.inc.get(id) || [];
    const widgets = Array.isArray(n.content) ? n.content : [];
    const meta = el('div', { class: 'meta' },
      n.weight != null ? el('span', { text: `weight ${n.weight}` }) : null,
      el('span', { text: `${outs.length} out · ${ins.length} in` }),
      el('span', { text: `${widgets.length} widget${widgets.length === 1 ? '' : 's'}` }),
      Array.isArray(n.position) ? el('span', { text: `position [${n.position.join(', ')}]` }) : null,
    );
    const titleBox = el('div', {},
      el('h1', { text: n.title || n.name || '(untitled)' }),
      n.title && n.name && n.title !== n.name ? el('div', { class: 'muted', text: n.name }) : null,
      meta,
    );
    head.append(titleBox);
    inner.append(head);

    if (n.description) {
      const desc = el('p', { class: 'desc', text: n.description });
      inner.append(desc);
      if (n.description.length > 900) {
        desc.classList.add('clamped');
        const btn = el('button', { class: 'link', text: 'Show more' });
        btn.addEventListener('click', () => { const c = desc.classList.toggle('clamped'); btn.textContent = c ? 'Show more' : 'Show less'; });
        inner.append(btn);
      }
    }

    // Widgets
    state.widgetList = widgets;
    if (widgets.length) {
      inner.append(el('h2', { text: `Widgets (${widgets.length})` }));
      const grid = el('div', { class: 'widgets' });
      widgets.forEach((w, i) => grid.append(widgetCard(w, i)));
      inner.append(grid);
    }

    // Links (all edges, with their relation labels)
    if (outs.length) {
      inner.append(el('h2', { text: `Links to (${outs.length})` }));
      inner.append(chipList(outs, 120));
    }
    if (ins.length) {
      inner.append(el('h2', { text: `Linked from (${ins.length})` }));
      inner.append(chipList(ins, 120));
    }

    // Hints & any other node properties
    const known = new Set(['id', 'name', 'title', 'weight', 'description', 'icon', 'position', 'content', 'hints']);
    const extraProps = Object.fromEntries(Object.entries(n).filter(([k]) => !known.has(k)));
    if (n.hints && typeof n.hints === 'object' && Object.keys(n.hints).length) inner.append(kvBox('Hints', n.hints, true));
    if (Object.keys(extraProps).length) inner.append(kvBox('Other properties', extraProps, false));
    inner.append(kvBox('Node id', { id }, false));

    detail.replaceChildren(inner);
    detail.scrollTop = keepScroll ? prevScroll : 0;
  }

  function chipList(edges, limit) {
    const box = el('div', { class: 'chips' });
    const render = (from, to) => {
      for (const e of edges.slice(from, to)) {
        const target = state.nodes.get(e.id);
        box.append(el('button', { class: 'chip', onclick: () => select(e.id, { center: true }), title: nodeName(target) },
          el('span', { text: nodeName(target) }),
          e.relation ? el('span', { class: 'rel', text: e.relation }) : null,
        ));
      }
      if (to < edges.length) {
        const more = el('button', { class: 'link', text: `+ ${fmt(edges.length - to)} more` });
        more.addEventListener('click', () => { more.remove(); render(to, Math.min(edges.length, to + limit)); });
        box.append(more);
      }
    };
    render(0, Math.min(edges.length, limit));
    return box;
  }

  function kvBox(title, obj, open) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(obj)) {
      let text = v;
      if (v != null && typeof v === 'object') text = Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v, null, 2);
      const dd = el('dd');
      if (typeof v === 'string' && /^https?:\/\//.test(v)) dd.append(el('a', { href: v, target: '_blank', rel: 'noopener', text: v }));
      else dd.textContent = String(text ?? '');
      dl.append(el('dt', { text: k }), dd);
    }
    return el('details', { class: 'box', open }, el('summary', { text: title }), dl);
  }

  // ---------------------------------------------------------------- widgets

  const wProps = (w) => (w && typeof w.properties === 'object' && w.properties) || {};
  const wTitle = (w) => wProps(w).title || w.name || w.title || '(widget)';

  function widgetCard(w, i) {
    const p = wProps(w);
    const card = el('button', { class: 'widget', onclick: () => openWidget(i) });
    const ph = el('div', { class: 'w-noimg', text: '▣' });
    const img = smartImg(p.icon || w.icon, { class: 'w-img' }, (im) => im && im.replaceWith(ph));
    card.append(img || ph);
    card.append(el('div', { class: 'w-body' },
      el('div', { class: 'w-title', text: wTitle(w) }),
      p.notes ? el('div', { class: 'w-notes', text: p.notes }) : null,
    ));
    return card;
  }

  function openWidget(i) {
    const w = state.widgetList[i];
    if (!w) return;
    const p = wProps(w);
    const body = $('modalBody');
    body.replaceChildren();

    const src = p.icon || w.icon;
    if (src) {
      const img = smartImg(src, { class: 'modal-img', loading: 'eager' }, (im) => im && im.remove());
      if (img) { img.addEventListener('click', () => window.open(img.currentSrc || img.src, '_blank', 'noopener')); body.append(img); }
    }

    const text = el('div', { class: 'modal-text' },
      el('h3', { id: 'modalTitle', text: wTitle(w) }),
      el('div', { class: 'sub', text: [w.name && w.name !== wTitle(w) ? w.name : null, w.type ? `type ${w.type}` : null,
        w.weight != null ? `weight ${w.weight}` : null, `${i + 1} of ${state.widgetList.length}`].filter(Boolean).join(' · ') }),
      p.notes ? el('div', { class: 'notes', text: p.notes }) : null,
      p.source_url ? el('a', { class: 'src', href: p.source_url, target: '_blank', rel: 'noopener', text: `Source ↗ ${p.source_url}` }) : null,
    );
    const known = new Set(['icon', 'title', 'notes', 'source_url']);
    const rest = Object.fromEntries(Object.entries(p).filter(([k, v]) => !known.has(k) && v !== '' && v != null));
    const restFlat = rest.extra && typeof rest.extra === 'object' && !Array.isArray(rest.extra)
      ? { ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'extra')), ...rest.extra } : rest;
    if (Object.keys(restFlat).length) text.append(kvBox('Details', restFlat, false));
    body.append(text);

    if (state.widgetList.length > 1) {
      body.append(el('div', { class: 'modal-nav' },
        el('button', { class: 'btn', text: '← Previous', disabled: i === 0, onclick: () => openWidget(i - 1) }),
        el('button', { class: 'btn', text: 'Next →', disabled: i === state.widgetList.length - 1, onclick: () => openWidget(i + 1) }),
      ));
    }
    $('modal')._index = i;
    $('modal').hidden = false;
    $('modal').querySelector('.modal-card').scrollTop = 0;
  }

  function openImage(src, title) {
    state.widgetList = [{ name: title, properties: { icon: src, title } }];
    openWidget(0);
    // Restore the node's widget list for the cards after closing.
    $('modal')._restore = state.selected;
  }

  function closeModal() {
    $('modal').hidden = true;
    if ($('modal')._restore) {
      const n = state.nodes.get($('modal')._restore);
      state.widgetList = (n && Array.isArray(n.content)) ? n.content : [];
      $('modal')._restore = null;
    }
  }
  $('modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if ($('modal').hidden) return;
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'ArrowRight') openWidget(($('modal')._index || 0) + 1);
    else if (e.key === 'ArrowLeft') openWidget(($('modal')._index || 0) - 1);
  });

  // ---------------------------------------------------------------- search

  let searchTimer = 0;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('search').value = ''; runSearch(); }
    if (e.key === 'Enter') { const first = $('results').querySelector('li[data-id]'); if (first) first.click(); }
  });

  function runSearch() {
    const q = $('search').value.trim().toLowerCase();
    const results = $('results');
    if (q.length < 2) { results.hidden = true; return; }

    const scored = [];
    for (const [id, n] of state.nodes) {
      const name = nodeName(n).toLowerCase();
      let score = -1;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q) || (n.title || '').toLowerCase().includes(q)) score = 2;
      else if (Array.isArray(n.content) && n.content.some((w) => wTitle(w).toLowerCase().includes(q))) score = 3;
      else if ((n.description || '').toLowerCase().includes(q)) score = 4;
      if (score >= 0) scored.push([score, name.length, id]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    results.replaceChildren();
    if (!scored.length) results.append(el('li', { class: 'r-note', text: 'No matches.' }));
    for (const [score, , id] of scored.slice(0, SEARCH_LIMIT)) {
      const n = state.nodes.get(id);
      const path = pathTo(id).slice(0, -1).map((p) => nodeName(state.nodes.get(p)));
      const where = score === 3 ? 'matches a widget' : score === 4 ? 'matches description' : '';
      results.append(el('li', { 'data-id': id, onclick: () => { $('search').value = ''; results.hidden = true; select(id, { center: true }); } },
        el('div', { class: 'r-name' }, highlight(nodeName(n), q)),
        el('div', { class: 'r-path', text: [path.slice(-3).join(' › '), where].filter(Boolean).join(' — ') || 'root' }),
      ));
    }
    if (scored.length > SEARCH_LIMIT) results.append(el('li', { class: 'r-note', text: `Showing ${SEARCH_LIMIT} of ${fmt(scored.length)} matches — refine your search.` }));
    results.hidden = false;
  }

  function highlight(text, q) {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return document.createTextNode(text);
    const f = document.createDocumentFragment();
    f.append(text.slice(0, i), el('mark', { text: text.slice(i, i + q.length) }), text.slice(i + q.length));
    return f;
  }

  // ---------------------------------------------------------------- file inputs

  $('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });


  // ---------------------------------------------------------------- boot

  const initial = new URL(location.href).searchParams.get('file');
  if (initial) loadFromUrl(initial, initial.split('/').pop());
})();
