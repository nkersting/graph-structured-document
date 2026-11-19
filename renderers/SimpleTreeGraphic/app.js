/* SimpleTreeGraphic — a minimal, dependency-free navigator for Graph Structured Documents (knowledge.json).
 *
 * Like SimpleTree, but the tree is drawn graphically, top-down like a decision tree: the root at the
 * top branching down to the leaves. The tree is a breadth-first spanning tree from graph.rootNodeId;
 * edges it doesn't use are listed on each node's detail page. Clicking a node shows its description,
 * hints and content widgets; clicking a widget opens it with its embedded image.
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
    document.title = `${title} — SimpleTreeGraphic`;
    const nEdges = [...state.out.values()].reduce((a, l) => a + l.length, 0);
    const nWidgets = [...state.nodes.values()].reduce((a, n) => a + (Array.isArray(n.content) ? n.content.length : 0), 0);
    setStatus([state.sourceName, d.description].filter(Boolean).join(' · '));
    $('nodeCount').textContent = `${fmt(state.nodes.size)} nodes · ${fmt(nEdges)} edges · ${fmt(nWidgets)} widgets`;

    $('search').disabled = false; $('search').value = '';
    $('results').hidden = true;
    $('treeEmpty').hidden = true;

    const fromHash = decodeURIComponent((location.hash.match(/node=([^&]+)/) || [])[1] || '');
    const first = state.nodes.has(fromHash) ? fromHash : state.roots[0];
    state.selected = first || null;
    initTree();
    if (first) select(first, { center: first !== state.roots[0] });
  }

  const fmt = (n) => n.toLocaleString();
  const nodeName = (n) => (n && (n.name || n.title)) || '(untitled)';

  function pathTo(id) {
    const path = [];
    for (let cur = id, guard = 0; cur != null && guard < 100000; cur = state.parent.get(cur), guard++) path.unshift(cur);
    return path;
  }

  // ---------------------------------------------------------------- graphic tree
  //
  // The BFS spanning tree drawn top-down like a decision tree: boxes for nodes, curved connectors
  // from each parent down to its children. Nodes expand and collapse; big child lists are shown a
  // page at a time behind a "show more" box. HTML boxes and an SVG edge layer share one
  // transformed "world" element, so panning and zooming is a single CSS transform.

  const PAGE = 12;          // children shown per page
  const NODE_W = 170, NODE_H = 54, GAP_X = 22;
  const MIN_LEVEL_H = 90;   // smallest gap between levels (room for the connector and the +/− button)

  const pane = $('treePane');
  const world = $('world');
  const edgeSvg = $('edges');
  const T = {
    expanded: new Set(),
    shown: new Map(),       // id -> how many children are visible (first page(s))
    extra: new Map(),       // id -> Set of children beyond the shown pages that were revealed by search/navigation
    pos: new Map(),         // id or more-key -> {x, y}  (top-left of box, world units)
    k: 1, tx: 0, ty: 0,
    boxes: new Map(),       // id -> element, for the current render
  };

  function initTree() {
    T.expanded = new Set(); T.shown = new Map(); T.extra = new Map();
    // Open the top: the root(s), and the level below too if the tree is small.
    for (const r of state.roots.slice(0, 3)) T.expanded.add(r);
    if (state.nodes.size <= 150) for (const r of state.roots) for (const c of state.children.get(r) || []) T.expanded.add(c);
    layoutAndRender();
    fitView(false);
    // Too wide to read when fitted: start at a readable zoom with the root at the top centre.
    if (T.k < 0.55 && T.pos.has(state.roots[0])) {
      const p = T.pos.get(state.roots[0]);
      T.k = 0.95;
      T.tx = pane.clientWidth / 2 - T.k * (p.x + NODE_W / 2);
      T.ty = 70;
      applyTransform(false);
    }
  }

  const shownCount = (id) => Math.min((state.children.get(id) || []).length, T.shown.get(id) || PAGE);
  /** Children currently drawn: the shown page(s) plus any revealed ones further down the list. */
  function visibleKids(id) {
    const kids = state.children.get(id) || [];
    const n = shownCount(id);
    const extra = T.extra.get(id);
    if (!extra || !extra.size) return kids.slice(0, n);
    return kids.filter((c, i) => i < n || extra.has(c));
  }

  /**
   * Simple tidy layout: leaves take consecutive slots, parents sit centred over their children.
   * The gap between levels is then chosen so the drawn tree is square (total height = total width),
   * recomputed on every expand/collapse. A tree too narrow to be square keeps the minimum gap.
   */
  function layout() {
    T.pos = new Map();
    let slot = 0, maxDepth = 0;
    const place = (id, depth) => {
      maxDepth = Math.max(maxDepth, depth);
      const kids = state.children.get(id) || [];
      if (!T.expanded.has(id) || !kids.length) {
        T.pos.set(id, { x: slot++ * (NODE_W + GAP_X), depth });
        return;
      }
      const vis = visibleKids(id);
      const first = slot;
      for (const c of vis) place(c, depth + 1);
      if (vis.length < kids.length) {
        T.pos.set('more:' + id, { x: slot++ * (NODE_W + GAP_X), depth: depth + 1, more: id });
        maxDepth = Math.max(maxDepth, depth + 1);
      }
      const last = slot - 1;
      T.pos.set(id, { x: ((first + last) / 2) * (NODE_W + GAP_X), depth });
    };
    // Several roots (graphs with unreachable parts) sit side by side, with a gap between.
    for (const r of state.roots) { place(r, 0); slot += 1; }

    let minX = Infinity, maxX = -Infinity;
    for (const p of T.pos.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + NODE_W); }
    const width = maxX - minX;
    T.levelH = maxDepth ? Math.max(MIN_LEVEL_H, (width - NODE_H) / maxDepth) : MIN_LEVEL_H;
    for (const p of T.pos.values()) p.y = p.depth * T.levelH;
  }

  function layoutAndRender(anchorId) {
    // Keep `anchorId` fixed on screen across the re-layout (the node you just clicked doesn't jump).
    const before = anchorId && T.pos.get(anchorId);
    const screenBefore = before && { x: before.x * T.k + T.tx, y: before.y * T.k + T.ty };
    layout();
    render();
    const after = anchorId && T.pos.get(anchorId);
    if (screenBefore && after) { T.tx = screenBefore.x - after.x * T.k; T.ty = screenBefore.y - after.y * T.k; applyTransform(false); }
  }

  function render() {
    const nodesFrag = document.createDocumentFragment();
    T.boxes = new Map();
    let maxX = 0, maxY = 0;
    const paths = [];

    for (const [key, p] of T.pos) {
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H + 30);
      if (p.more) {
        const parent = p.more, kids = state.children.get(parent);
        const rest = kids.length - visibleKids(parent).length;
        const box = el('button', { class: 'tnode more', style: `left:${p.x}px;top:${p.y}px`, title: 'Show more children' },
          el('span', { class: 'more-text', text: `+ ${fmt(Math.min(PAGE, rest))} more` }),
          el('span', { class: 'more-sub', text: `${fmt(rest)} hidden` }));
        box.addEventListener('click', (e) => { e.stopPropagation(); T.shown.set(parent, shownCount(parent) + PAGE); layoutAndRender(key); });
        nodesFrag.append(box);
        paths.push(edgePath(T.pos.get(parent), p, true));
        continue;
      }
      const id = key;
      const n = state.nodes.get(id);
      const kids = state.children.get(id) || [];
      const widgets = Array.isArray(n.content) ? n.content.length : 0;
      const open = T.expanded.has(id) && kids.length;
      const img = nodeImage(n) ? smartImg(nodeImage(n), { class: 'tthumb', draggable: 'false' }, (im) => im && im.remove()) : null;
      const box = el('div', {
        class: 'tnode' + (id === state.selected ? ' selected' : '') + (depthOf(id) === 0 ? ' root' : ''),
        style: `left:${p.x}px;top:${p.y}px`, 'data-id': id, title: nodeName(n),
      },
        img,
        el('div', { class: 'tbody' },
          el('div', { class: 'tname', text: nodeName(n) }),
          el('div', { class: 'tmeta' },
            widgets ? el('span', { text: `▣ ${widgets}` }) : null,
            kids.length ? el('span', { text: `${fmt(kids.length)} ${kids.length === 1 ? 'child' : 'children'}` }) : null)),
      );
      if (kids.length) {
        const t = el('button', { class: 'ttoggle' + (open ? ' open' : ''), title: open ? 'Collapse' : `Expand ${kids.length} children`, text: open ? '−' : '+' });
        t.addEventListener('click', (e) => { e.stopPropagation(); toggleNode(id); });
        box.append(t);
      }
      box.addEventListener('click', () => { if (!pane._dragged) { select(id); if (!T.expanded.has(id) && kids.length) toggleNode(id); } });
      T.boxes.set(id, box);
      nodesFrag.append(box);
      const parent = state.parent.get(id);
      if (parent != null && T.pos.has(parent)) paths.push(edgePath(T.pos.get(parent), p, false, id));
    }

    world.querySelectorAll('.tnode').forEach((b) => b.remove());
    world.append(nodesFrag);
    edgeSvg.setAttribute('width', maxX + 40); edgeSvg.setAttribute('height', maxY + 40);
    edgeSvg.innerHTML = paths.join('');
    highlightPath();
  }

  function edgePath(a, b, dashed, childId) {
    const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H + 10, x2 = b.x + NODE_W / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    return `<path data-to="${childId ? escAttr(childId) : ''}" class="${dashed ? 'dashed' : ''}" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/>`;
  }
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /** Colour the connectors from the root down to the selected node. */
  function highlightPath() {
    edgeSvg.querySelectorAll('path.on').forEach((p) => p.classList.remove('on'));
    if (!state.selected) return;
    for (const id of pathTo(state.selected).slice(1)) {
      const p = edgeSvg.querySelector(`path[data-to="${CSS.escape(id)}"]`);
      if (p) p.classList.add('on');
    }
  }

  function depthOf(id) { return pathTo(id).length - 1; }

  function toggleNode(id) {
    if (T.expanded.has(id)) T.expanded.delete(id); else T.expanded.add(id);
    layoutAndRender(id);
  }

  /** Make a node visible: expand its ancestors and page far enough to include it. */
  function revealNode(id) {
    const path = pathTo(id);
    let changed = false;
    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i];
      if (!T.expanded.has(p)) { T.expanded.add(p); changed = true; }
      const idx = (state.children.get(p) || []).indexOf(path[i + 1]);
      if (idx >= shownCount(p) && !T.extra.get(p)?.has(path[i + 1])) {
        if (!T.extra.has(p)) T.extra.set(p, new Set());
        T.extra.get(p).add(path[i + 1]); changed = true;
      }
    }
    if (changed) layoutAndRender();
  }

  // ---- view transform

  function applyTransform(animate) {
    world.classList.toggle('animating', !!animate);
    world.style.transform = `translate(${T.tx}px, ${T.ty}px) scale(${T.k})`;
    pane.style.setProperty('--zoom', T.k);
  }
  world.addEventListener('transitionend', () => world.classList.remove('animating'));
  // The pane clips its content; never let the browser scroll it (e.g. to bring a focused box into view).
  pane.addEventListener('scroll', () => { if (pane.scrollLeft || pane.scrollTop) { pane.scrollLeft = 0; pane.scrollTop = 0; } });

  function fitView(animate = true) {
    if (!T.pos.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of T.pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H + 12); }
    const w = pane.clientWidth, h = pane.clientHeight, pad = 50;
    T.k = Math.max(0.05, Math.min(1.1, (w - 2 * pad) / (maxX - minX), (h - 2 * pad - 40) / (maxY - minY)));
    T.tx = w / 2 - T.k * (minX + maxX) / 2;
    T.ty = Math.max(pad + 40, h / 2 - T.k * (minY + maxY) / 2);
    applyTransform(animate);
  }

  function centerOnNode(id, animate = true) {
    const p = T.pos.get(id);
    if (!p) return;
    T.k = Math.max(T.k, 0.9);
    T.tx = pane.clientWidth / 2 - T.k * (p.x + NODE_W / 2);
    T.ty = pane.clientHeight / 2 - T.k * (p.y + NODE_H / 2);
    applyTransform(animate);
  }

  function zoomAt(sx, sy, factor, animate) {
    const k = Math.min(3, Math.max(0.05, T.k * factor));
    const wx = (sx - T.tx) / T.k, wy = (sy - T.ty) / T.k;
    T.k = k; T.tx = sx - wx * k; T.ty = sy - wy * k;
    applyTransform(animate);
  }

  // ---- pan / zoom interaction

  let drag = null;
  pane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.overlay, .ttoggle, .tnode.more, input')) return;
    drag = { x: e.clientX, y: e.clientY, tx: T.tx, ty: T.ty, id: e.pointerId };
    pane._dragged = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!pane._dragged && Math.hypot(dx, dy) < 4) return;
    if (!pane._dragged) { pane._dragged = true; pane.classList.add('grabbing'); try { pane.setPointerCapture(drag.id); } catch { /* ignore */ } }
    T.tx = drag.tx + dx; T.ty = drag.ty + dy;
    applyTransform(false);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null; pane.classList.remove('grabbing');
    setTimeout(() => { pane._dragged = false; }, 0); // let the click that ends a drag be ignored
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  pane.addEventListener('wheel', (e) => {
    if (!state.nodes.size || e.target.closest('.overlay')) return;
    e.preventDefault();
    const r = pane.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0015), false);
  }, { passive: false });

  const mid = () => [pane.clientWidth / 2, pane.clientHeight / 2];
  $('zoomIn').addEventListener('click', () => zoomAt(...mid(), 1.4, true));
  $('zoomOut').addEventListener('click', () => zoomAt(...mid(), 1 / 1.4, true));
  $('zoomFit').addEventListener('click', () => fitView(true));
  $('collapseAll').addEventListener('click', () => {
    T.expanded = new Set(state.roots.slice(0, 3)); T.shown = new Map(); T.extra = new Map();
    if (state.selected) revealNode(state.selected);
    layoutAndRender(); fitView(true);
  });
  $('expandLevel').addEventListener('click', () => {
    // open every visible collapsed node (one more level), capped so huge trees stay usable
    let opened = 0;
    for (const id of [...T.pos.keys()]) {
      if (id.startsWith('more:') || T.expanded.has(id) || !(state.children.get(id) || []).length) continue;
      T.expanded.add(id);
      if (++opened >= 200) break;
    }
    layoutAndRender(); fitView(true);
  });

  // Keyboard: ↑ parent, ↓ first child, ← → siblings, Enter toggles, +/− zoom, 0 fits.
  pane.addEventListener('keydown', (e) => {
    if (!$('modal').hidden || !state.selected || e.target.closest('input')) return;
    const id = state.selected;
    const parent = state.parent.get(id);
    const sibs = parent != null ? (state.children.get(parent) || []) : state.roots;
    const i = sibs.indexOf(id);
    const go = (to) => { if (to != null) { e.preventDefault(); select(to, { center: true }); } };
    switch (e.key) {
      case 'ArrowUp': go(parent); break;
      case 'ArrowDown': {
        const kids = state.children.get(id) || [];
        if (kids.length) { if (!T.expanded.has(id)) toggleNode(id); go(kids[0]); }
        break;
      }
      case 'ArrowLeft': go(sibs[i - 1]); break;
      case 'ArrowRight': go(sibs[i + 1]); break;
      case 'Enter': e.preventDefault(); toggleNode(id); break;
      case '+': case '=': zoomAt(...mid(), 1.3, true); break;
      case '-': case '_': zoomAt(...mid(), 1 / 1.3, true); break;
      case '0': fitView(true); break;
    }
  });

  // ---------------------------------------------------------------- selection / detail

  /** Select a node. `center` pans the tree to it (used when navigating from the panel or search). */
  function select(id, opts = {}) {
    if (!state.nodes.has(id)) return;
    T.boxes.get(state.selected)?.classList.remove('selected');
    state.selected = id;
    revealNode(id);
    T.boxes.get(id)?.classList.add('selected');
    highlightPath();
    if (opts.center) centerOnNode(id);
    if (!pane.contains(document.activeElement) || document.activeElement === document.body) pane.focus({ preventScroll: true });
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
    const kids = state.children.get(id) || [];
    const widgets = Array.isArray(n.content) ? n.content : [];
    const meta = el('div', { class: 'meta' },
      n.weight != null ? el('span', { text: `weight ${n.weight}` }) : null,
      el('span', { text: `${kids.length} child${kids.length === 1 ? '' : 'ren'}` }),
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

    // Children
    if (kids.length) {
      inner.append(el('h2', { text: `Children (${kids.length})` }));
      inner.append(chipList(kids.map((cid) => ({ id: cid })), 120));
    }

    // Other connections (edges not used by the tree)
    const parent = state.parent.get(id);
    const otherOut = (state.out.get(id) || []).filter((e) => state.parent.get(e.id) !== id);
    const otherIn = (state.inc.get(id) || []).filter((e) => e.id !== parent);
    if (otherOut.length) {
      inner.append(el('h2', { text: `Also links to (${otherOut.length})` }));
      inner.append(chipList(otherOut, 120));
    }
    if (otherIn.length) {
      inner.append(el('h2', { text: `Also linked from (${otherIn.length})` }));
      inner.append(chipList(otherIn, 120));
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
