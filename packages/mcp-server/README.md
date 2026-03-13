# @origintrail-official/dkg-mcp-server

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for DKG V9. Exposes DKG node capabilities as MCP tools, allowing AI assistants (Cursor, Claude Desktop, etc.) to publish, query, and explore the knowledge graph.

## Features

- **MCP stdio transport** — runs as a subprocess, communicating via stdin/stdout per the MCP spec
- **DkgClient** — connects to a running DKG node's HTTP API with authentication
- **Code graph tools** — find modules, functions, classes, and packages from indexed repositories
- **Knowledge graph tools** — SPARQL queries and data publishing
- **File summaries** — retrieve summaries of indexed source files

## Available Tools

| Tool | Description |
|------|-------------|
| `dkg_find_modules` | Find modules/files in the indexed code graph |
| `dkg_find_functions` | Search for functions by name or signature |
| `dkg_find_classes` | Search for classes in the code graph |
| `dkg_find_packages` | List indexed packages |
| `dkg_file_summary` | Get a structured summary of a source file |
| `dkg_query` | Execute a SPARQL query against the knowledge graph |
| `dkg_publish` | Publish RDF data to a paranet |

## Setup

```json
{
  "mcpServers": {
    "dkg": {
      "command": "npx",
      "args": ["@origintrail-official/dkg-mcp-server"],
      "env": {
        "DKG_NODE_URL": "http://localhost:9200",
        "DKG_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Usage

The MCP server requires a running DKG node. It connects to the node's HTTP API using the `DKG_NODE_URL` and `DKG_API_TOKEN` environment variables.

```bash
# Run directly (usually configured in your AI assistant instead)
DKG_NODE_URL=http://localhost:9200 DKG_API_TOKEN=xxx dkg-mcp
```

## Internal Dependencies

None — communicates with the DKG node over HTTP. Uses `@modelcontextprotocol/sdk` and `zod` for MCP protocol handling.
