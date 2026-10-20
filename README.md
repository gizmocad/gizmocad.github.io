# GizmoCAD

3D CAD that's as easy as Tinkercad but precise enough for real parts. It runs in the browser and also as a desktop app.

- Drag shapes in (box, cylinder, sphere, cone, tube, ring, wedge, pyramid, polygon prism, hedron (4, 6, 8, 12 or 20 faces), thread, gear, spring, star, text, screw hole),
  then type exact sizes. A thread set to Hole makes a threaded hole (nut); gears have real involute teeth.
  Springs come as coils (round or square wire, open or flat ends) or flat zigzag springs (rounded or sharp bends) that print lying down.
  **Text** comes in 13 built-in fonts (plain, serif, typewriter, rounded, narrow, poster, stencil, sci-fi, cartoon, comic,
  script, handwriting, old English; bold where the font has it), or **import your own** .ttf, .otf or .woff font (it's saved
  inside the model). Any alignment, several lines; make it a Hole to engrave it.
  **Screw holes** (M2–M10) go down into the face you put them on, with a tap, close, normal or loose fit and an optional
  counterbore, countersink, hex nut trap (ISO 4032 nuts, 0.2 mm play) or heat-set insert hole at the top.
  Fields accept units and maths (`1in`, `2.5cm`, `40/3`), and **parameters**: add named values under Parameters (`wall = 2`, `gap = wall/4`) and type `wall*2` into any size field. Such a field stays linked (marked green) and follows when the parameter changes.
- **Placing shapes:** click a shape button (or drag it into the view) and a preview follows the mouse. Click to put it
  on the face under the mouse, standing out from that face and snapped to its grid, centre and corners, or on the ground grid.
  Press F while placing to flip it into the face instead (hanging under it, or an axle pointing down). Right-click or Esc cancels.
- **Hinges, axles, orbits & sliders:** in an object's Connection section, click Hinge, Orbit (circles an axis
  while staying upright) or Slider, then click a point on
  the object it attaches to, or on the object itself and then the object it attaches to (the face there sets the axis;
  the empty build plate is ignored). It's then attached to that object: Spin/Slide (J) moves it on the
  connection (drag the ring or arrow, or type the angle/distance, with optional limits), while Move and Rotate reposition
  it together with its connection, and Pivot (P) moves just the connection (it snaps to object points).
- **Onto face** (F): move the selected object onto another object's face (or the grid) the same way.
- **Lay flat:** with the Move or Rotate gizmo, click **Lay flat** then a face of the selected object: it turns so that face sits on the bed, ready to print.
- **Show/hide** objects with the eye in the object list (or H). Hidden objects still count in the model and exports.
- **Select several objects:** Shift/Ctrl-click (in the view or the list), Shift-drag a box in the view, or Ctrl+A. Then move or
  turn them together with the gizmo, **align** their sides or centres, **space them evenly**, colour, mirror, duplicate,
  delete, or **group** them (Ctrl+G).
- **Copy and paste** (Ctrl+C / Ctrl+X / Ctrl+V), also between GizmoCAD windows.
- **Mirror** any object (or several) along X, Y or Z, in place.
- **Ghost** an object (G, or the ghost button in the list): it turns see-through and clicks, placing and snapping go
  through it, so you can put things inside or behind it. It's still part of the model and exports.
- **Repeat:** copies in a row, a grid, or around a circle (e.g. holes round a flange), previewed before they're added.
- **Hollow:** turn a solid into walls of a set thickness, open at the top or bottom, or closed.
- **Textures:** real, printable surface patterns on any solid: diamond knurl, ribs, rings, bumps, honeycomb, square grid,
  bricks, waves, wood grain or rough (fuzzy skin), pressed in or raised, on its sides, top or all faces, wrapped around round
  shapes or laid flat. Shown as you work and in STL/3MF exports (STEP keeps the plain exact shape).
- **Tilt:** taper an object's sides in or out by an angle (the base keeps its size), or lean the whole shape over along X or Y.
- **Colours** per object (new objects take turns through green, orange, purple, yellow and pink), shown in the view and saved into 3MF exports.
- **Measure** (M): click two points (corners and edges snap) for the distance and its X/Y/Z parts; two faces also give their angle.
- **Print estimate:** a selected object (or several) shows roughly what printing it takes: weight in grams for the chosen material and infill, metres of 1.75 mm filament, and cost at your price per kg. GizmoCAD menu ▸ Print estimate does the whole model.
- **Print check** (⚠ in the view's corner): overhangs steeper than 45° that don't sit on the bed show orange, walls thinner than 0.8 mm (two nozzle widths) red, with how much of each.
- Mark any shape as a **hole**: what it cuts is shown cut as you work, with the hole itself see-through so you can still move it.
  Holes cut imported meshes (STL, OBJ, 3MF…) too, using the Manifold mesh library, as long as the mesh is closed.
  **Show result** shows only the finished boolean result (parts merged), computed by the OpenCascade kernel.
- **Sweep & loft:** a sketch can become a **sweep** (each brush stroke turns into a round or square tube as thick as the stroke: pipes, handles, rails) or a **loft** (its first shape blends into another sketch's, e.g. square at the bottom to round at the top; place that sketch where the loft should end).
- **Sketches:** points, guide lines, rectangles (rounded corners, any angle), circles, ellipses,
  regular polygons, slots, polygons with arc edges, smooth curves (closer points make tighter bends), and freehand brush strokes, on the XY/XZ/YZ plane or any
  tilted Plane object. Shapes can add to the profile, cut it, or just act as guides. Snap to existing
  points and the grid (hold Alt to place freely). Edit by dragging the dots, typing exact values, or right-clicking.
  A finished sketch stays flat (just a drawing) until you click Extrude (up, down or both ways) or Revolve in the 3D view.
- **Split & dividers:** cut any shape or sketch into pieces along X, Y or Z, tilted at any angle, with as many parallel
  cuts as you like (drag each cut's arrow or type it, or space them evenly; all pieces stay editable),
  or add evenly spaced divider walls (count, thickness, height), e.g. inside a tray.
  **Alignment pins** on a split: each cut gets dowel holes (placed inside the cut face, as far apart as they fit) in both pieces, and the pins to print go beside the model.
  In sketches, the Trim tool (T) merges shapes where you click an edge inside another shape, trims off the part of a shape sticking out
  of another when you click its outside edge, cuts a shape along a guide line (dropping the side you click), or trims a guide line back
  to its crossings, and "Trim overlaps" merges all selected overlapping shapes. The Split tool (X) cuts a line or brush stroke in two, or adds a corner to a shape's edge.
- **Sketch constraints:** with the Constrain tool (K), click one or two points, edges or circles and pick horizontal,
  vertical, parallel, perpendicular, equal, tangent, coincident or fixed, or a length, distance, diameter or angle
  dimension. The drawing then keeps to them as you edit it, and the values can be changed in the panel.
- **Fillets & chamfers:** round or bevel all, top, bottom or vertical edges, or edges you click.
  On a group they act on the merged result (e.g. the rim of a hole). A size that's too big for
  the shape is automatically reduced to the largest safe size, and the panel shows the size used.
- **Sculpting:** free-form clay (start from a sphere or cube, or turn any shape, sketch or group
  into clay with "Sculpt this object") shaped with Draw, Inflate, Smooth,
  Flatten and Grab brushes, with optional X mirroring and "Add detail" to refine the mesh. Sculpts are meshes: they export to STL
  (not STEP) and don't take part in holes or fillets.
- **Parent/child objects:** drag objects onto each other in the list (or use the Parent dropdown).
  Children move with their parent, and a child hole only cuts its own parent's branch. Groups are empty containers.
- **Move / Rotate / Resize** gizmo (W / E / R). Resizing changes the object's real dimensions,
  snapped to the grid, rather than stretching it. **Keep ratio** (or Shift while dragging) resizes
  evenly, and a 3D ruler shows the size along each axis as you drag. **One side** resizes only the end whose handle you drag, keeping the opposite
  face where it is. Spheres stretch into ellipsoids and cylinders into ovals.
- **Points**: while moving, every object shows snap points (corners, edge middles, face centres).
  Drag an object near another's point and it snaps there, so faces and edges line up exactly.
  The Points menu can hide the dots (snapping still works) or turn point snapping off.
- **View cube** in the corner of the 3D view turns with the camera; click a face, edge or corner to look from that side.
  Below it: fit everything in view (Home), zoom to the selection (.), **see-through** (X: X-ray with every edge
  showing, then wireframe), a **section view** that cuts the model open along X, Y or Z, and Measure.
- **History** along the bottom: every object is a step. Roll back to see (and edit) the model as it was at any step;
  new objects go in at the marker, and changes flow through to the later steps. Right-click a step to switch it off.
- **Autosave:** your work is kept in the browser/app and comes back next time you open GizmoCAD.
- **Print bed:** pick your printer in the GizmoCAD menu to see its bed and get a warning when the model doesn't fit.
- Snap to the grid, undo/redo. New, Open, Save, Export and Theme are in the menu under the GizmoCAD logo.
- Export **STEP** (for other CAD programs), **STL** (for 3D printing) and **3MF** (for slicers, one object per part,
  with colours). **Import** several files at once (or drop them on the window); they land side by side:
  - **STEP**, **FreeCAD (.FCStd)** and **BREP** as exact solids that can be holes, take fillets and be split
    (FreeCAD files keep each visible object's name, colour and placement, and bring their sketches as flat drawings you can edit: lines and arcs as shapes, circles, ellipses and curves, holes inside shapes kept as holes);
  - **STL**, **3MF**, **OBJ** (with its .mtl), **PLY**, **OFF** and **glTF/GLB** meshes (3MF keeps part names, colours and layout).
    Closed meshes up to 200,000 triangles become solids with all the usual options (holes, fillets, chamfers, tapers,
    shells, textures): flat areas become single faces, curves keep their facets but are shaded smooth, and only real
    corners count as edges. Bigger or open meshes stay meshes; **Make it a solid** converts one (or a sculpt) later;
  - **DXF** and **SVG** drawings as sketches (lines and arcs that join up become shapes, holes included);
  - another **GizmoCAD** model, brought into this one.
- **Exports** hold just the selected objects (with the holes that reach them still cut) when something is selected, or the whole model when nothing is.
- **Combine:** select several objects and click **⧉ Combine** to join them into one shape (it shows, rounds and exports as one solid). A group's **Combine into one shape** switch turns this on or off.
- **Folders:** groups (Group button, Ctrl+G, or drag objects onto each other in the list) fold shut with the ▾ arrow beside them.
- **Chisel:** on a solid, **Chisel** then drag across a face to carve a groove (set its width, depth and Flat, V or Round tip). Each stroke is a hole inside the object whose sketch can be edited.
- **Clearance:** a hole can grow by a set amount on every side, so a part the same shape fits into what it cuts.
  On a solid, **Make a clearance cut** adds a copy of it as a hole 0.2 mm bigger all round that cuts what it sits in but not itself.
  On a group (or an object with parts inside it) the cut is one hole around all of it.
  A cut made from a hinged or sliding object (without clearing the full swing) gets a copy of its joint, and the two move together.
  On something with a hinge or slider, **Clear the full swing** sweeps the cut where the part moves: it starts at 0 to 0, and dragging its orange ends stretches it (turning the part itself leaves it alone).
  The same tick box on the cut switches the sweep off and on again.
- **Cut by holes:** untick a hole in an object's panel and it leaves that object (and anything inside it) alone, while still cutting everything else it reaches.
- **AI assistant (MCP):** let Claude (or any MCP-capable assistant) build and edit the model while you watch. See below.

## AI assistant (MCP)

GizmoCAD can be driven by an AI assistant through the [Model Context Protocol](https://modelcontextprotocol.io).
The assistant runs a small local server, [`public/mcp/gizmocad-mcp.mjs`](public/mcp/gizmocad-mcp.mjs) (Node 18+, no
dependencies), and GizmoCAD connects to it when you switch on **Connect** in the GizmoCAD menu ▸ **AI assistant (MCP)**.
The same dialog has a download button for the server and copy-ready setup lines.

- **Claude Code:** `claude mcp add gizmocad -- node /full/path/to/gizmocad-mcp.mjs`
- **Claude Desktop:** add to `claude_desktop_config.json` (Settings ▸ Developer ▸ Edit config), then restart it:
  ```json
  { "mcpServers": { "gizmocad": { "command": "node", "args": ["/full/path/to/gizmocad-mcp.mjs"] } } }
  ```

Tools: `get_model`, `list_shape_types`, `add_object` (every shape kind, sketches with extrude/revolve, groups),
`update_object` (sizes, placement, solid/hole, colour, fillets/chamfers/bevels, hollow, tilt, mirror, parent),
`delete_objects`, `group_objects`, `screenshot` (any view, optionally the finished boolean result), `select_objects`,
`undo`, `redo`, `new_model`, `save_file` (.gizmocad, .stl, .3mf, .step), `open_file` and `import_files` (any of the import formats).
Every change is a normal undoable step, and build errors and auto-shrunk fillets are reported back to the assistant.

The bridge listens only on `127.0.0.1:7473` and accepts connections only from GizmoCAD's own pages (the website,
the desktop app, or a local dev server). Set `GIZMOCAD_MCP_PORT` (and the same port in the dialog) to use another port,
and `GIZMOCAD_MCP_ORIGINS` to allow another origin (e.g. a self-hosted copy). Safari blocks the website from reaching
localhost; use Chrome, Edge, Firefox or the desktop app.

## Development

```bash
npm install
npm run dev            # website at http://localhost:5173
npm run tauri dev      # desktop app (needs Rust + system WebKit)
```

## Releasing

- **Website:** every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).
  Enable it once under *Settings → Pages → Source: GitHub Actions*.
- **Installers:** push a version tag (`git tag v0.1.0 && git push --tags`). GitHub builds
  Windows (`.msi`/`.exe`), macOS (`.dmg`) and Linux (`.deb`/`.AppImage`) installers and
  attaches them to a draft Release (`.github/workflows/release.yml`). Bump the version in
  `package.json` and `src-tauri/tauri.conf.json` first.

## How it's built

| File | Role |
|---|---|
| `src/model.ts` | The document: a list of operations (shapes with exact parameters). |
| `src/kernel.worker.ts` | Rebuilds geometry with replicad/OpenCascade in a Web Worker. |
| `src/kernel.ts` | Promise API the UI uses to talk to the worker. |
| `src/viewport.ts` | Three.js view: Z-up workplane, orbit, picking, move gizmo, sketch-mode camera. |
| `src/sketcher.ts` | Sketch tools, selection, handles, snapping, context menu. |
| `src/sculpt.ts` | Sculpt meshes, brushes, and adding them to STL exports. |
| `src/sketchGeometry.ts` | Exact outlines of sketch shapes, shared by the kernel and the editor. |
| `src/constraints.ts` | Sketch constraints and the solver that keeps drawings to them. |
| `src/fileFormats.ts` | 3MF export and import, STL and SVG import, autosave. |
| `src/importFormats.ts` | OBJ, OFF, PLY, glTF, DXF and FreeCAD import (STEP/BREP are read by the kernel). |
| `src/viewCube.ts` | The view orientation cube. |
| `src/main.ts` | UI: panels, undo/redo, commands, keyboard shortcuts. |
| `src/storage.ts` | Save/open: native dialogs in the desktop app, downloads on the web. |
| `src/mcpBridge.ts` | The app's side of MCP: carries out an AI assistant's tool calls as undoable edits. |
| `public/mcp/gizmocad-mcp.mjs` | The MCP server the assistant runs (stdio), bridged to the app over a local WebSocket. |
| `src-tauri/` | Desktop wrapper and installer config. |

## Roadmap

1. ~~Primitives, exact dimensions, snapping, holes, STEP/STL export~~
2. ~~Sketches (extrude/revolve) and parent/child objects~~
3. ~~Sketch constraints (equal, parallel, tangent, dimensions)~~
4. ~~Multi-select, alignment and measuring tools~~
5. ~~Editable history (roll back, switch steps off)~~

## Credits

Text uses the Roboto, Roboto Slab (SIL Open Font License 1.1) and Roboto Mono (Apache 2.0) fonts, bundled via Fontsource.
