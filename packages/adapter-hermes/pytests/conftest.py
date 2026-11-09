"""Pytest fixtures for the Hermes DKG plugin unit tests.

These tests are pure-Python and never touch a live daemon. They load the
plugin the same way the TS adapter tests do (importlib with stubbed
``agent.memory_provider`` / ``tools.registry`` modules), then drive the
client / provider with a fake ``_post`` recorder.

The tests live OUTSIDE ``hermes-plugin/`` on purpose: that directory ships its
own ``__init__.py`` (it IS the plugin module), so a sibling ``tests/`` would be
swept up as a sub-package and the plugin would be imported before the host
stubs below are installed. Keeping the tests at the package root avoids that.

Run from the package root (``packages/adapter-hermes``):

    python -m pytest

or filter to one file:

    python -m pytest pytests/test_multi_root_publish.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

# pytests/ -> packages/adapter-hermes/ -> hermes-plugin/
PLUGIN_DIR = Path(__file__).resolve().parent.parent / "hermes-plugin"


def _install_stub_modules() -> None:
    """Register the host modules the plugin imports at module load."""
    if "agent.memory_provider" not in sys.modules:
        agent_pkg = types.ModuleType("agent")
        memory_provider = types.ModuleType("agent.memory_provider")

        class MemoryProvider:  # minimal stand-in for the Hermes base class
            pass

        memory_provider.MemoryProvider = MemoryProvider
        sys.modules["agent"] = agent_pkg
        sys.modules["agent.memory_provider"] = memory_provider

    if "tools.registry" not in sys.modules:
        tools_pkg = types.ModuleType("tools")
        registry = types.ModuleType("tools.registry")

        def tool_error(message: str) -> str:
            return json.dumps({"error": message})

        registry.tool_error = tool_error
        sys.modules["tools"] = tools_pkg
        sys.modules["tools.registry"] = registry


# Install the host stubs at conftest import time so any import of the plugin's
# __init__.py resolves agent.memory_provider / tools.registry instead of
# failing.
_install_stub_modules()


def _load(name: str, filename: str, *, as_package: bool = False):
    spec = importlib.util.spec_from_file_location(
        name,
        PLUGIN_DIR / filename,
        submodule_search_locations=[str(PLUGIN_DIR)] if as_package else None,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def client_module():
    """The plugin's ``client.py`` loaded in isolation."""
    return _load("hermes_dkg_client", "client.py")


@pytest.fixture(scope="session")
def plugin_module():
    """The plugin's ``__init__.py`` loaded with host stubs in place."""
    sys.modules.setdefault("plugins", types.ModuleType("plugins"))
    sys.modules.setdefault("plugins.memory", types.ModuleType("plugins.memory"))
    return _load("plugins.memory.dkg", "__init__.py", as_package=True)


@pytest.fixture
def recording_client(client_module, hermes_host):
    """A DKGClient subclass whose HTTP layer is replaced by a recorder.

    ``posts`` captures ``(path, body)`` tuples. ``responder`` is an optional
    callable ``(path, body) -> response`` overriding the default success dict.
    """

    class RecordingClient(client_module.DKGClient):
        def __init__(self):
            super().__init__()
            self.posts = []
            self.responder = None

        def _post(self, path, data=None):  # type: ignore[override]
            self.posts.append((path, data))
            if self.responder is not None:
                return self.responder(path, data)
            return {"success": True, "echoed": data}

    return RecordingClient()


@pytest.fixture
def hermes_host(tmp_path, monkeypatch):
    """An isolated host profile; never read the developer's real Hermes/DKG state."""
    import os
    for key in tuple(os.environ):
        if key.startswith(("DKG_", "HERMES_DKG_")):
            monkeypatch.delenv(key)
    home = tmp_path / "profile"
    home.mkdir()
    monkeypatch.setenv("DKG_HOME", str(tmp_path / "node"))
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: home))
    return home


@pytest.fixture
def provider_factory(plugin_module, hermes_host, monkeypatch):
    """Real provider + real client routing, with only the daemon transport replaced."""
    import importlib
    from unittest.mock import Mock
    client = importlib.import_module(plugin_module.__name__ + ".client")
    post = Mock(return_value={"success": True, "assertionUri": "urn:memory"})
    get = Mock(return_value={"peerId": "peer-local"})
    health = Mock(return_value=True)
    monkeypatch.setattr(client.DKGClient, "_post", post)
    monkeypatch.setattr(client.DKGClient, "_get", get)
    monkeypatch.setattr(client.DKGClient, "health_check", health)
    providers = []

    def create(config=None, *, initialize=True, **kwargs):
        (hermes_host / "dkg.json").write_text(json.dumps(config or {}))
        provider = plugin_module.DKGMemoryProvider()
        providers.append(provider)
        if initialize:
            provider.initialize("session-1", **kwargs)
        return provider

    create.post, create.get, create.health = post, get, health
    create.home = hermes_host
    yield create
    for provider in providers:
        provider.shutdown()
