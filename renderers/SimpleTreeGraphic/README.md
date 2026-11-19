# SimpleTreeGraphic

A minimal, dependency-free renderer for Graph Structured Documents (`knowledge.json`). It works
like [SimpleTree](../SimpleTree/), except the tree is drawn graphically, top-down like a decision
tree, with the root at the top branching down to the leaves. It's three static files
(`index.html`, `app.js`, `styles.css`), with no build step and no install.

- **Tree.** The tree is a breadth-first spanning tree from `graph.rootNodeId`, following
  `graph.edges` in file order. Each node is a box with its image, name, widget count and child
  count, and curved connectors run from each parent down to its children.
- **Expanding.** Click a node to open it on the right; if it's collapsed, it also expands. The
  small **+ / −** under a box expands or collapses it without selecting it. Large families are
  shown 12 children at a time, followed by a dashed **+ more** box. The node you click stays in
  place while the tree re-lays out around it.
- **Pan and zoom.** Drag to pan and scroll to zoom. The buttons zoom in (+), zoom out (−), fit
  the visible tree (⤢), expand one more level (⇣) and collapse all (⇡).
- **Keyboard.** With the tree focused, ↑ goes to the parent, ↓ to the first child, and ← and → to
  siblings. Enter expands or collapses; `+`, `−` and `0` zoom and fit.
- **Node detail.** This works as in SimpleTree: breadcrumbs, description, image, widgets,
  children, *Also links to* and *Also linked from* (the edges the tree doesn't use), and hints.
  Clicking a breadcrumb or link expands the tree down to that node and centers it, and the
  connectors from the root to the selected node are highlighted.
- **Widgets.** Click a card to open it full-size with its notes, source link and `extra` fields;
  ← and → step through them.
- **Search.** The box over the tree finds nodes by name, widget title or description, then
  expands the tree down to the one you choose and centers it.

## Run

Open `index.html` in a browser, then use **Open file…** or drag a `knowledge.json` onto the page.
You can also serve the repository root and open `/renderers/SimpleTreeGraphic/`:

```bash
cd graph-structured-document
python3 -m http.server 8000   # then open http://localhost:8000/renderers/SimpleTreeGraphic/
```

`?file=<url>` loads a document served over http, and `#node=<id>` selects a node.

## Images

Absolute image URLs (`https://…`) are used as-is. Relative or root paths such as
`/INFORMS/sayno.png` are looked up in these places, in order:

1. the **image base**, if you set one (⚙ in the top bar; it's saved in the browser)
2. `../DynamicTree/public/` relative to this page, where the existing examples keep their images
3. the path as written

Nodes without an `icon` of their own show their first widget's image instead.
