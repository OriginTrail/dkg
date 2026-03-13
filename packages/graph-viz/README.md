# @origintrail-official/dkg-graph-viz

RDF Knowledge Graph Visualizer for the [OriginTrail Decentralized Knowledge Graph (DKG)](https://origintrail.io). Renders knowledge graphs with hexagonal nodes, force-directed layout, native RDF data loading, and declarative view configuration.

## Features

### Core Visualization
- **RDF native**: Load N-Triples, N-Quads, Turtle, or JSON-LD directly
- **Force-directed layout**: Physics-based graph layout via d3-force
- **Hexagonal nodes**: Distinctive hexagonal rendering with type-based coloring
- **Interactive**: Click nodes for details, zoom, pan, drag
- **Focus filtering**: Auto-focuses on high-degree nodes for large graphs
- **Reification collapsing**: Collapses RDF statement metadata for cleaner views
- **React support**: Optional React component wrapper

### Declarative View Configuration
- **ViewConfig JSON**: Declaratively control focal entities, node types, highlights, tooltips, and sizing from a single JSON file
- **Highlight rules**: Mark nodes based on any RDF property (self or linked), with continuous size scaling and optional `invert` mode
- **Size-by rules**: Scale node size by any numeric property using linear or logarithmic scaling
- **Configurable tooltips**: Define title properties, subtitle templates with tokens, and custom metric fields
- **Platform icons**: Map entities to SVG icons with URL-based fallback matching

### Color Palette System
- **Built-in themes**: Dark, Midnight, Cyberpunk, Light
- **CSS custom properties**: Palettes inject `--gv-*` variables for consistent theming
- **Custom palettes**: Supply your own `ColorPalette` object or override individual colors

### Graph Animations
- **Link particles**: Animated particles flowing along edges
- **Drift**: Subtle continuous movement
- **Risk pulse**: Breathing/pulsating animation on flagged nodes
- **Hover trace**: Animated particles on edges connected to the hovered node
- **Fade-in**: Smooth opacity transition on load

### Data Sources
- **OxigraphSource**: In-browser WASM-based SPARQL engine (Oxigraph)
- **RemoteSparqlSource**: Connect to any SPARQL endpoint (GraphDB, Fuseki, etc.)
- **SPARQL-driven views**: Load and switch graph views via CONSTRUCT queries

## Quick Start

```bash
pnpm install
pnpm --filter @origintrail-official/dkg-graph-viz demo
```

Open http://localhost:4321 to see the Moltbook social graph demo.

## Usage (Vanilla JS)

```javascript
import { RdfGraphViz, OxigraphSource } from '@origintrail-official/dkg-graph-viz';

const container = document.getElementById('graph');
const viz = new RdfGraphViz(container, {
  labelMode: 'humanized',
  focus: { maxNodes: 5000 },
});

// Load via SPARQL source
const kg = new OxigraphSource();
await kg.init();
await kg.loadNTriples(ntriplesText);
await viz.loadFromSource(kg, 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');

// Apply a declarative view config
const viewConfig = await fetch('/views/my-view.json').then(r => r.json());
viz.applyView(viewConfig);
```

### View Config Example

```json
{
  "name": "Social Graph",
  "nodeTypes": {
    "https://schema.org/Person": {
      "label": "Person",
      "color": "#9b59b6",
      "shape": "hexagon",
      "sizeMultiplier": 1.8
    },
    "https://schema.org/SocialMediaPosting": {
      "label": "Post",
      "color": "#3498db",
      "shape": "hexagon",
      "sizeMultiplier": 1.2
    }
  },
  "palette": "midnight",
  "animation": {
    "drift": true,
    "hoverTrace": true,
    "fadeIn": true
  },
  "tooltip": {
    "titleProperties": ["name", "headline"],
    "subtitleTemplate": "{type} · {author} · {date}",
    "fields": [
      { "label": "Score", "property": "score", "format": "number" }
    ]
  }
}
```

## Usage (React)

```jsx
import { RdfGraph } from '@origintrail-official/dkg-graph-viz/react';

function App() {
  return (
    <RdfGraph
      data={ntriplesString}
      format="ntriples"
      options={{ labelMode: 'humanized' }}
      onNodeClick={(node) => console.log(node)}
    />
  );
}
```

## Supported RDF Formats

| Format | Method | Extension |
|--------|--------|-----------|
| N-Triples | `loadNTriples(text)` | `.nt` |
| N-Quads | `loadNQuads(text)` | `.nq` |
| Turtle | `loadTurtle(text)` | `.ttl` |
| JSON-LD | `loadJsonLd(obj)` | `.jsonld` |

## Architecture

```
src/
├── core/
│   ├── rdf-graph-viz.ts        # Main facade class
│   ├── graph-model.ts          # In-memory graph (nodes, edges, properties)
│   ├── view-config.ts          # Declarative ViewConfig application
│   ├── palette.ts              # Color palette system (4 built-in themes)
│   ├── style-engine.ts         # Node/edge coloring with palette integration
│   ├── hexagon-painter.ts      # 2D hexagonal node renderer
│   ├── renderer.ts             # Canvas2D renderer backend (force-graph)
│   ├── renderer-3d.ts          # WebGL 3D renderer backend (3d-force-graph)
│   ├── renderer-backend.ts     # Renderer interface
│   ├── provenance-resolver.ts  # DKG provenance metadata extraction
│   ├── label-resolver.ts       # URI → human-readable label
│   ├── prefix-manager.ts       # RDF namespace prefix handling
│   ├── focus-filter.ts         # Large-graph node filtering
│   ├── reification-collapser.ts # RDF reification collapsing
│   ├── metadata-extractor.ts   # Metadata predicate extraction
│   ├── events.ts               # Event emitter (node:click, node:hover, etc.)
│   └── types.ts                # TypeScript type definitions
├── data-sources/
│   ├── oxigraph-source.ts      # In-browser WASM SPARQL engine
│   ├── remote-sparql-source.ts # Remote SPARQL endpoint client
│   └── types.ts                # Data source interfaces
├── react/                      # React component wrapper
└── parsers/                    # RDF format parsers
```

## Building

```bash
pnpm --filter @origintrail-official/dkg-graph-viz build       # Build for distribution (ESM + CJS + DTS)
pnpm --filter @origintrail-official/dkg-graph-viz dev         # Watch mode
pnpm --filter @origintrail-official/dkg-graph-viz demo        # Start Vite dev server for demos
pnpm --filter @origintrail-official/dkg-graph-viz test        # Run tests
```

## License

MIT
