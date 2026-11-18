# Simple

A minimal, dependency-free renderer for Graph Structured Documents (`knowledge.json`).
It's three static files (`index.html`, `app.js`, `styles.css`), with no build step and no install.

- **Tree.** The graph is shown as a collapsible tree, a breadth-first spanning tree from
  `graph.rootNodeId` that follows `graph.edges` in file order. Children are rendered only when
  a node is expanded, and in pages of 200, so the 7,000+ node British Museum examples stay fast.
- **Node detail.** Click a node to see its title, description, children and content widgets.
  Edges the tree didn't use (extra parents, `succeeds`, `conquers` and other cross-links) are
  listed under *Also links to* / *Also linked from*. `hints` and any other properties are shown
  as key–value tables.
- **Widgets.** Each entry in `content[]` is a card with its embedded image (`properties.icon`).
  Click a card to open it full-size with its notes, source link and `extra` fields. In the modal,
  ← and → step through the node's widgets.
- **Search.** Matches node names and titles first, then widget titles, then descriptions.
- **Keyboard.** In the tree, ↑ and ↓ move between rows, → and ← expand and collapse, and Enter toggles.
- **Deep links.** `?file=<url>` loads a document served over http, and `#node=<id>` selects a node.

## Run

Open `index.html` in a browser, then use **Open file…** or drag a `knowledge.json` onto the page.
You can open it straight from disk, or serve the repository root and open `/renderers/Simple/`:

```bash
cd graph-structured-document
python3 -m http.server 8000   # then open http://localhost:8000/renderers/Simple/
```

## Images

Absolute image URLs (`https://…`) are used as-is. Relative or root paths such as
`/INFORMS/sayno.png` are looked up in these places, in order:

1. the **image base**, if you set one (⚙ in the top bar; it's saved in the browser)
2. `../DynamicTree/public/` relative to this page, where the existing examples keep their images
3. the path as written

Nodes without an `icon` of their own show their first widget's image instead.
