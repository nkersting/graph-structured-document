# SimpleGraph

A minimal, dependency-free renderer for Graph Structured Documents (`knowledge.json`) that shows
the **whole graph**, not a tree. It's three static files (`index.html`, `app.js`, `styles.css`),
with no build step and no install. Its detail panel works the same way as
[SimpleTree](../SimpleTree/)'s.

- **Graph.** Every node and edge is drawn on a canvas with a force-directed layout. The layout
  starts from a radial layout of the root's breadth-first tree, so large documents (the 7,000+
  node British Museum examples) settle within seconds.
- **Pan and zoom.** Drag the background to pan and scroll to zoom. The buttons zoom in (+), zoom
  out (−), fit the whole graph (⤢) and run the layout again (⟳). With the graph focused, you can
  also pan with the arrow keys, zoom with `+` and `−`, and fit with `0`. You can drag a node to
  move it.
- **Node detail.** Click a node to open it on the right, with its title, description, image,
  widgets, *Links to* and *Linked from* lists (with relation labels), and hints. Clicking a link
  or breadcrumb opens that node and centers the graph on it.
- **Widgets.** Each entry in `content[]` is a card with its embedded image. Click a card to open
  it full-size with its notes, source link and `extra` fields; ← and → step through them.
- **Search.** The box over the graph finds nodes by name, widget title or description, and
  centers the graph on the one you choose.
- **Reading the picture.** A node's color shows how many steps it is from the root. Filled nodes
  have widgets and hollow rings don't. Size follows `weight`. When a node is selected, its edges
  are highlighted with arrows showing direction.

## Run

Open `index.html` in a browser, then use **Open file…** or drag a `knowledge.json` onto the page.
You can also serve the repository root and open `/renderers/SimpleGraph/`:

```bash
cd graph-structured-document
python3 -m http.server 8000   # then open http://localhost:8000/renderers/SimpleGraph/
```

`?file=<url>` loads a document served over http, and `#node=<id>` selects a node.

## Images

Absolute image URLs (`https://…`) are used as-is. Relative or root paths such as
`/INFORMS/sayno.png` are looked up in these places, in order:

1. the **image base**, if you set one (⚙ in the top bar; it's saved in the browser)
2. `../DynamicTree/public/` relative to this page, where the existing examples keep their images
3. the path as written

Nodes without an `icon` of their own show their first widget's image instead.
