/* Simple — a minimal, dependency-free navigator for Graph Structured Documents (knowledge.json).
 *
 * The graph is shown as a tree: a breadth-first spanning tree from graph.rootNodeId, following
 * graph.edges in the order they appear. Edges not used by the tree (extra parents, cross-links)
 * are listed on each node's detail page as connections. Clicking a node shows its description,
 * hints and content widgets; clicking a widget opens it with its embedded image.
 */
(() => {
  'use strict';

  const CHILD_PAGE = 200;            // children rendered per "show more" page
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
    rows: new Map(),       // id -> <li> once rendered
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
    state.rows = new Map(); state.roots = []; state.selected = null;

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
    document.title = `${title} — Simple`;
    const nEdges = [...state.out.values()].reduce((a, l) => a + l.length, 0);
    const nWidgets = [...state.nodes.values()].reduce((a, n) => a + (Array.isArray(n.content) ? n.content.length : 0), 0);
    setStatus([state.sourceName, d.description].filter(Boolean).join(' · '));
    $('nodeCount').textContent = `${fmt(state.nodes.size)} nodes · ${fmt(nEdges)} edges · ${fmt(nWidgets)} widgets`;

    $('search').disabled = false; $('search').value = '';
    $('collapseAll').disabled = false;
    $('results').hidden = true; $('tree').hidden = false;

    renderTree();
    if (state.roots.length <= 3) state.roots.forEach(expand); // open the top level so the tree isn't a single row
    const fromHash = decodeURIComponent((location.hash.match(/node=([^&]+)/) || [])[1] || '');
    const first = state.nodes.has(fromHash) ? fromHash : state.roots[0];
    if (first) { reveal(first); select(first); }
  }

  const fmt = (n) => n.toLocaleString();
  const nodeName = (n) => (n && (n.name || n.title)) || '(untitled)';

  function pathTo(id) {
    const path = [];
    for (let cur = id, guard = 0; cur != null && guard < 100000; cur = state.parent.get(cur), guard++) path.unshift(cur);
    return path;
  }

  // ---------------------------------------------------------------- tree

  function renderTree() {
    const tree = $('tree');
    tree.replaceChildren();
    appendChildren(tree, state.roots, 0);
  }

  function appendChildren(ul, ids, start) {
    const end = Math.min(ids.length, start + CHILD_PAGE);
    for (let i = start; i < end; i++) ul.append(makeRow(ids[i]));
    if (end < ids.length) {
      const li = el('li', { class: 'more' });
      li.append(el('button', {
        class: 'link', text: `Show ${fmt(Math.min(CHILD_PAGE, ids.length - end))} more of ${fmt(ids.length - end)}…`,
        onclick: () => { li.remove(); appendChildren(ul, ids, end); },
      }));
      ul.append(li);
    }
  }

  function makeRow(id) {
    const n = state.nodes.get(id);
    const kids = state.children.get(id) || [];
    const widgets = Array.isArray(n.content) ? n.content.length : 0;

    const caret = el('button', { class: 'caret' + (kids.length ? '' : ' leaf'), tabindex: '-1', 'aria-label': 'Toggle', text: '▶' });
    const row = el('div', { class: 'row', tabindex: '-1', 'data-id': id, title: nodeName(n) },
      caret,
      nodeImage(n) ? smartImg(nodeImage(n), { class: 'thumb' }, (img) => img && img.remove()) : null,
      el('span', { class: 'label', text: nodeName(n) }),
      widgets ? el('span', { class: 'badge', title: `${widgets} widget${widgets === 1 ? '' : 's'}`, text: `▣ ${widgets}` }) : null,
      kids.length ? el('span', { class: 'badge', title: `${kids.length} children`, text: kids.length }) : null,
    );
    const li = el('li', { role: 'treeitem', 'aria-expanded': kids.length ? 'false' : null }, row);
    li._id = id;
    state.rows.set(id, li);

    caret.addEventListener('click', (e) => { e.stopPropagation(); toggle(id); });
    row.addEventListener('click', () => select(id));
    row.addEventListener('dblclick', () => toggle(id));
    if (state.selected === id) row.classList.add('selected');
    return li;
  }

  function isOpen(id) { const li = state.rows.get(id); return !!(li && li._kids && !li._kids.hidden); }

  function expand(id) {
    const li = state.rows.get(id);
    const kids = state.children.get(id) || [];
    if (!li || !kids.length) return;
    if (!li._kids) { li._kids = el('ul', { role: 'group' }); appendChildren(li._kids, kids, 0); li.append(li._kids); }
    li._kids.hidden = false;
    li.setAttribute('aria-expanded', 'true');
    li.querySelector(':scope > .row > .caret').classList.add('open');
  }

  function collapse(id) {
    const li = state.rows.get(id);
    if (!li || !li._kids) return;
    li._kids.hidden = true;
    li.setAttribute('aria-expanded', 'false');
    li.querySelector(':scope > .row > .caret').classList.remove('open');
  }

  function toggle(id) { isOpen(id) ? collapse(id) : expand(id); }

  /** Expand ancestors so the row exists, including paging through "show more". */
  function reveal(id) {
    const path = pathTo(id);
    for (let i = 0; i < path.length; i++) {
      const pid = path[i];
      if (!state.rows.has(pid)) {
        // Parent is open but this child sits beyond the rendered page: render pages until it appears.
        const parentLi = i > 0 ? state.rows.get(path[i - 1]) : null;
        const ul = parentLi ? parentLi._kids : $('tree');
        let guard = 0;
        while (!state.rows.has(pid) && guard++ < 10000) {
          const more = ul && ul.querySelector(':scope > li.more > button');
          if (!more) break;
          more.click();
        }
      }
      if (i < path.length - 1) expand(pid);
    }
    const li = state.rows.get(id);
    if (li) li.firstChild.scrollIntoView({ block: 'nearest' });
  }

  $('collapseAll').addEventListener('click', () => {
    for (const id of state.rows.keys()) collapse(id);
    if (state.selected) reveal(state.selected);
  });

  // Keyboard navigation over visible rows.
  $('treeWrap').addEventListener('keydown', (e) => {
    if (!state.selected || $('tree').hidden) return;
    const rows = [...$('tree').querySelectorAll('.row')].filter((r) => r.offsetParent !== null);
    const idx = rows.findIndex((r) => r.dataset.id === state.selected);
    const go = (r) => { if (r) { e.preventDefault(); select(r.dataset.id); r.focus({ preventScroll: true }); r.scrollIntoView({ block: 'nearest' }); } };
    switch (e.key) {
      case 'ArrowDown': go(rows[idx + 1]); break;
      case 'ArrowUp': go(rows[idx - 1]); break;
      case 'ArrowRight':
        e.preventDefault();
        if ((state.children.get(state.selected) || []).length && !isOpen(state.selected)) expand(state.selected);
        else go(rows[idx + 1]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isOpen(state.selected)) collapse(state.selected);
        else { const p = state.parent.get(state.selected); if (p) go(state.rows.get(p)?.firstChild); }
        break;
      case 'Enter': e.preventDefault(); toggle(state.selected); break;
    }
  });

  // ---------------------------------------------------------------- selection / detail

  function select(id, opts = {}) {
    if (!state.nodes.has(id)) return;
    if (state.selected) state.rows.get(state.selected)?.firstChild.classList.remove('selected');
    state.selected = id;
    reveal(id);
    const li = state.rows.get(id);
    if (li) { li.firstChild.classList.add('selected'); li.firstChild.focus({ preventScroll: true }); }
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
        else crumbs.append(el('button', { text: nodeName(state.nodes.get(pid)), onclick: () => select(pid) }));
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
        box.append(el('button', { class: 'chip', onclick: () => select(e.id), title: nodeName(target) },
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
    if (q.length < 2) { results.hidden = true; $('tree').hidden = false; return; }

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
      results.append(el('li', { 'data-id': id, onclick: () => { $('search').value = ''; results.hidden = true; $('tree').hidden = false; select(id); } },
        el('div', { class: 'r-name' }, highlight(nodeName(n), q)),
        el('div', { class: 'r-path', text: [path.slice(-3).join(' › '), where].filter(Boolean).join(' — ') || 'root' }),
      ));
    }
    if (scored.length > SEARCH_LIMIT) results.append(el('li', { class: 'r-note', text: `Showing ${SEARCH_LIMIT} of ${fmt(scored.length)} matches — refine your search.` }));
    $('tree').hidden = true; results.hidden = false;
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
