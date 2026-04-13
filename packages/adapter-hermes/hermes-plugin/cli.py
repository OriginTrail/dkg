"""CLI commands for the DKG memory plugin.

Provides `hermes dkg status`, `hermes dkg query`, and `hermes dkg sync`
for debugging and manual operations.
"""

from __future__ import annotations

import json
import sys


def register_cli(cli_group):
    """Register DKG CLI commands with the Hermes CLI."""

    import click

    @cli_group.group("dkg")
    def dkg():
        """DKG node commands — status, query, sync."""
        pass

    @dkg.command("status")
    def dkg_status():
        """Show DKG node connection, context graphs, and assertion stats."""
        from plugins.memory.dkg.client import DKGClient
        from plugins.memory.dkg import _load_config, _load_cache

        config = _load_config()
        agent_name = config.get("agent_name", "")
        client = DKGClient(base_url=config.get("daemon_url", "http://127.0.0.1:9200"))

        if not client.health_check():
            cache = _load_cache(agent_name)
            click.echo("DKG Status: OFFLINE")
            click.echo(f"  Daemon URL: {config.get('daemon_url')}")
            click.echo(f"  Cached memory entries: {len(cache.get('memory', []))}")
            click.echo(f"  Cached user entries: {len(cache.get('user', []))}")
            click.echo(f"  Queued writes: {len(cache.get('queued_writes', []))}")
            return

        status = client.status()
        cg_list = client.list_context_graphs()

        click.echo("DKG Status: CONNECTED")
        click.echo(f"  Daemon URL: {config.get('daemon_url')}")
        click.echo(f"  Peer ID: {status.get('peerId', 'unknown')}")
        click.echo(f"  Context Graph: {config.get('context_graph', 'hermes-memory')}")
        if isinstance(cg_list, list):
            click.echo(f"  Subscribed CGs: {len(cg_list)}")
            for cg in cg_list[:5]:
                name = cg.get("name", cg.get("id", "?"))
                click.echo(f"    - {name}")
        client.close()

    @dkg.command("query")
    @click.argument("sparql")
    def dkg_query(sparql):
        """Run a SPARQL query against the DKG node."""
        from plugins.memory.dkg.client import DKGClient
        from plugins.memory.dkg import _load_config

        config = _load_config()
        client = DKGClient(base_url=config.get("daemon_url", "http://127.0.0.1:9200"))

        if not client.health_check():
            click.echo("Error: DKG daemon is not reachable.", err=True)
            sys.exit(1)

        result = client.query(sparql, config.get("context_graph"))
        click.echo(json.dumps(result, indent=2))
        client.close()

    @dkg.command("sync")
    def dkg_sync():
        """Force-sync local cache to DKG (useful after offline period).

        Replays queued mutations (add/replace/remove) against the local
        cache in order, then writes the final materialized state to DKG
        once per affected target.  This preserves semantics — removes
        actually delete facts, and replaces overwrite them.
        """
        from plugins.memory.dkg.client import DKGClient
        from plugins.memory.dkg import _load_config, _load_cache, _save_cache

        config = _load_config()
        agent_name = config.get("agent_name", "")
        client = DKGClient(base_url=config.get("daemon_url", "http://127.0.0.1:9200"))

        if not client.health_check():
            click.echo("Error: DKG daemon is not reachable.", err=True)
            sys.exit(1)

        cache = _load_cache(agent_name)
        queued = cache.get("queued_writes", [])
        if not queued:
            click.echo("Nothing to sync — no queued writes.")
            client.close()
            return

        click.echo(f"Syncing {len(queued)} queued writes...")
        context_graph = config.get("context_graph", "hermes-memory")
        assertion_name = agent_name or "hermes"
        synced = 0
        failed = []
        dirty_targets: set = set()

        for item in queued:
            try:
                if item.get("type") == "turn":
                    client.store_turn(
                        item["session_id"],
                        item.get("user", ""),
                        item.get("assistant", ""),
                    )
                    synced += 1
                elif item.get("type") == "memory":
                    action = item.get("action", "add")
                    target = item.get("target", "memory")
                    content = item.get("content", "")
                    old_text = item.get("old_text", "")
                    entries = list(cache.get(target, []))

                    if action == "add":
                        entries.append({"target": target, "content": content})
                    elif action == "replace":
                        replaced = False
                        for i, e in enumerate(entries):
                            if old_text and old_text in e.get("content", ""):
                                entries[i] = {"target": target, "content": content}
                                replaced = True
                                break
                        if not replaced:
                            entries.append({"target": target, "content": content})
                    elif action == "remove":
                        entries = [e for e in entries if content not in e.get("content", "")]

                    cache[target] = entries
                    dirty_targets.add(target)
                    synced += 1
                else:
                    synced += 1
            except Exception as e:
                click.echo(f"  Failed: {e}")
                failed.append(item)

        write_failures = 0
        for target in dirty_targets:
            entries = cache.get(target, [])
            quads = [{
                "subject": f"urn:hermes:{assertion_name}:{target}",
                "predicate": "urn:hermes:content",
                "object": f"[{e.get('target', target)}]\n{e['content']}",
            } for e in entries]
            try:
                client.write_assertion(assertion_name, context_graph, quads)
            except Exception as e:
                click.echo(f"  Failed to write {target} assertion: {e}")
                write_failures += 1

        cache["queued_writes"] = failed
        _save_cache(cache, agent_name)
        click.echo(f"Synced {synced}/{len(queued)} writes ({len(dirty_targets)} targets updated). {len(failed)} remaining.")
        if write_failures:
            click.echo(f"  Warning: {write_failures} assertion write(s) failed — data is saved locally, re-run sync to retry.")
        client.close()
