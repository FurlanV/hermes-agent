"""``auth_command`` on HTTP MCP servers (tools/mcp_tool_auth_command.py): a bearer token minted by a fixed
command (argv, no shell), cached until shortly before expiry, re-minted once after a 401, registered for
redaction, and kept out of the connection's identity digest. Servers without the key behave as before.

The end-to-end cells run a real Streamable HTTP MCP server (uvicorn subprocess) that only accepts the bearer
tokens listed in a file, and a real token command that counts its runs."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tools import mcp_tool_auth_command as ac

# --------------------------------------------------------------------------------------------- helpers
TOKEN_COMMAND = textwrap.dedent("""
    import json, pathlib, sys, time
    state = pathlib.Path(sys.argv[1])
    count = state / "count"
    n = int(count.read_text()) + 1 if count.exists() else 1
    count.write_text(str(n))
    if (state / "fail").exists():
        print("tok-should-not-leak", file=sys.stderr)
        sys.exit(3)
    if (state / "hang").exists():
        time.sleep(30)
    token = f"tok-{n}-s3cr3tvalue"
    mode = (state / "mode").read_text() if (state / "mode").exists() else "json"
    ttl = int((state / "ttl").read_text()) if (state / "ttl").exists() else 3600
    if mode == "bare":
        print(token)
    elif mode == "lines":
        print("banner"); print(token)
    elif mode == "nojson":
        print(json.dumps({"token": token}))
    else:
        print(json.dumps({"access_token": token, "expires_in": ttl}))
""")

HTTP_SERVER = textwrap.dedent("""
    import asyncio, json, pathlib, socket, sys
    import uvicorn
    from mcp.server import MCPServer
    state = pathlib.Path(sys.argv[1])
    server = MCPServer("gw")

    @server.tool()
    def whoami() -> str:
        return "ok"

    def guarded(app):
        async def wrapped(scope, receive, send):
            if scope["type"] != "http":
                return await app(scope, receive, send)
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            auth = headers.get("authorization", "")
            body = b""
            if scope.get("method") == "POST":
                while True:
                    event = await receive()
                    body += event.get("body", b"")
                    if not event.get("more_body"):
                        break
            try:
                method = json.loads(body).get("method") if body else scope.get("method")
            except Exception:
                method = None
            accept = (state / "accept").read_text().split() if (state / "accept").exists() else None
            ok = auth.startswith("Bearer tok-") and (accept is None or auth[len("Bearer "):] in accept)
            with open(state / "requests.log", "a") as fh:
                fh.write(json.dumps([method, auth, ok]) + "\\n")
            if not ok:
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"unauthorized"})
                return
            replayed = False

            async def replay():
                nonlocal replayed
                if replayed:
                    return await receive()
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await app(scope, replay, send)
        return wrapped

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    uv = uvicorn.Server(uvicorn.Config(guarded(server.streamable_http_app()), log_level="warning"))

    async def main():
        task = asyncio.create_task(uv.serve(sockets=[sock]))
        while not uv.started:
            await asyncio.sleep(0.01)
        (state / "port").write_text(str(sock.getsockname()[1]))
        await task

    asyncio.run(main())
""")


@pytest.fixture
def command(tmp_path):
    """``(argv, state dir)`` of a token command that prints ``tok-<run>-s3cr3tvalue``."""
    state = tmp_path / "cmd"
    state.mkdir()
    script = tmp_path / "token_command.py"
    script.write_text(TOKEN_COMMAND, encoding="utf-8")
    return [sys.executable, str(script), str(state)], state


def runs(state: Path) -> int:
    return int((state / "count").read_text()) if (state / "count").exists() else 0


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# --------------------------------------------------------------------------------------------- config
def test_absent_key_is_none_and_malformed_values_are_refused():
    assert ac.auth_command_argv("s", {"url": "https://x"}) is None
    assert ac.auth_command_argv("s", {"url": "https://x", "auth_command": None}) is None
    assert ac.auth_command_argv("s", {"auth_command": ["athena", "token"]}) == ["athena", "token"]
    for bad in ("athena token", [], ["athena", 3], [""], {"cmd": "x"}):
        with pytest.raises(ValueError, match="list of strings"):
            ac.auth_command_argv("s", {"auth_command": bad})


# --------------------------------------------------------------------------------------------- the token source
def test_json_token_is_cached_until_shortly_before_expiry(command):
    argv, state = command
    (state / "ttl").write_text("120")
    clock = Clock()
    source = ac.AuthCommandToken("gw", argv, clock=clock)
    first = source.token()
    assert first == "tok-1-s3cr3tvalue" and runs(state) == 1
    clock.now += 59  # 120s ttl - 60s leeway = 60s of reuse
    assert source.token() == first and runs(state) == 1
    clock.now += 2
    assert source.token() == "tok-2-s3cr3tvalue" and runs(state) == 2


def test_iso_expiry_is_honoured(tmp_path):
    script = tmp_path / "iso.py"
    script.write_text("import json, datetime\n"
                      "exp = datetime.datetime.now(datetime.UTC) + datetime.timedelta(seconds=600)\n"
                      "print(json.dumps({'access_token': 'tok-iso', 'expiry': exp.isoformat()}))\n")
    clock = Clock()
    source = ac.AuthCommandToken("gw", [sys.executable, str(script)], clock=clock)
    assert source.token() == "tok-iso"
    clock.now += 530  # ~540s of reuse
    assert source.token() == "tok-iso" and source.mints == 1
    clock.now += 20
    source.token()
    assert source.mints == 2


def test_bare_token_gets_the_default_ttl(command):
    argv, state = command
    (state / "mode").write_text("bare")
    clock = Clock()
    source = ac.AuthCommandToken("gw", argv, clock=clock)
    assert source.token() == "tok-1-s3cr3tvalue"
    clock.now += ac._NO_TTL_REFRESH_SECONDS - 1
    assert source.token() == "tok-1-s3cr3tvalue"
    clock.now += 2
    assert source.token() == "tok-2-s3cr3tvalue"


@pytest.mark.parametrize("mode, message", [
    ("fail", "exited 3"), ("lines", "several lines"), ("nojson", "without an 'access_token'")])
def test_a_failing_command_raises_a_clear_error_without_its_output(command, mode, message):
    argv, state = command
    (state / ("fail" if mode == "fail" else "mode")).write_text(mode)
    source = ac.AuthCommandToken("gw", argv)
    with pytest.raises(ac.AuthCommandError, match=message) as info:
        source.token()
    text = str(info.value)
    assert "MCP server 'gw'" in text and "tok-" not in text and argv[1] not in text
    assert source.last_error == text


def test_a_hung_command_times_out(command, monkeypatch):
    argv, state = command
    (state / "hang").write_text("1")
    monkeypatch.setattr(ac, "_MINT_TIMEOUT_SECONDS", 1.0)
    started = time.monotonic()
    with pytest.raises(ac.AuthCommandError, match="timed out after 1s"):
        ac.AuthCommandToken("gw", argv).token()
    assert time.monotonic() - started < 10


def test_the_command_runs_without_a_shell(tmp_path):
    marker = tmp_path / "shell-ran"
    source = ac.AuthCommandToken("gw", ["/bin/echo", f"tok; touch {marker}"])
    assert source.token() == f"tok; touch {marker}"  # one argv item, echoed verbatim
    assert not marker.exists()


def test_every_token_is_registered_for_redaction(command):
    from agent.redact import redact_sensitive_text

    argv, _state = command
    token = ac.AuthCommandToken("gw", argv).token()
    assert token not in redact_sensitive_text(f"header was {token}")


def test_refresh_after_401_mints_once_and_reuses_a_newer_token(command):
    argv, state = command
    source = ac.AuthCommandToken("gw", argv)
    first = source.token()
    second = source.refresh_after_401(first)
    assert second == "tok-2-s3cr3tvalue" and runs(state) == 2
    assert source.refresh_after_401(first) == second and runs(state) == 2  # another request already refreshed
    (state / "fail").write_text("1")
    assert source.refresh_after_401(second) is None  # the 401 stands; logged, not raised
    assert "exited 3" in (source.last_error or "")


# --------------------------------------------------------------------------------------------- the httpx flow
def _client(source, handler):
    from tools.mcp_tool import sdk_httpx

    httpx_mod = sdk_httpx()
    return httpx_mod.AsyncClient(auth=ac.httpx_auth(httpx_mod, source), transport=httpx_mod.MockTransport(handler))


def test_flow_attaches_the_bearer_and_retries_a_401_once(command):
    argv, state = command
    seen: list[str] = []

    def handler(request):
        from tools.mcp_tool import sdk_httpx

        seen.append(request.headers.get("authorization", ""))
        ok = request.headers.get("authorization") == "Bearer tok-2-s3cr3tvalue"
        return sdk_httpx().Response(200 if ok else 401, content=request.content)

    async def go():
        async with _client(ac.AuthCommandToken("gw", argv), handler) as client:
            return await client.post("https://gw.example/mcp", content=b'{"jsonrpc":"2.0"}')

    resp = asyncio.run(go())
    assert resp.status_code == 200 and resp.content == b'{"jsonrpc":"2.0"}'  # the body was re-sent
    assert seen == ["Bearer tok-1-s3cr3tvalue", "Bearer tok-2-s3cr3tvalue"] and runs(state) == 2


def test_flow_gives_up_after_one_refresh(command):
    argv, state = command
    seen: list[str] = []

    def handler(request):
        from tools.mcp_tool import sdk_httpx

        seen.append(request.headers.get("authorization", ""))
        return sdk_httpx().Response(401)

    async def go():
        async with _client(ac.AuthCommandToken("gw", argv), handler) as client:
            return await client.get("https://gw.example/mcp")

    assert asyncio.run(go()).status_code == 401
    assert len(seen) == 2 and runs(state) == 2


# --------------------------------------------------------------------------------------------- unchanged without the key
def _drive_http(server, config):
    """``_run_http`` with the SDK boundary mocked (``test_mcp_identity_header.py``'s pattern); the
    ``AsyncClient`` kwargs and the identity the transport published."""
    from tools.mcp_tool import MCPServerTask, sdk_httpx

    captured: dict = {}

    class DummyAsyncClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class DummyTransportCtx:
        async def __aenter__(self):
            return MagicMock(), MagicMock(), (lambda: None)

        async def __aexit__(self, *a):
            return False

    class DummySession:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

    async def _discover_tools(self):
        self._shutdown_event.set()

    async def _drive():
        with patch("tools.mcp_tool._MCP_HTTP_AVAILABLE", True), \
             patch("tools.mcp_tool._MCP_NEW_HTTP", True), \
             patch.object(sdk_httpx(), "AsyncClient", DummyAsyncClient), \
             patch("tools.mcp_tool.streamable_http_client", return_value=DummyTransportCtx()), \
             patch("tools.mcp_tool.ClientSession", DummySession), \
             patch.object(MCPServerTask, "_discover_tools", _discover_tools):
            await server._run_http(config)

    asyncio.run(_drive())
    return captured


def test_without_auth_command_no_auth_and_the_same_identity(command):
    from tools.mcp_tool import MCPServerTask
    from tools.mcp_tool_registration import _identity_digest

    argv, state = command
    plain = MCPServerTask("remote")
    captured = _drive_http(plain, {"url": "https://example.com/mcp", "headers": {"X-Team": "a"}})
    assert "auth" not in captured and plain._auth_command_source is None
    assert not any(k.lower() == "authorization" for k in captured.get("headers") or {})
    assert runs(state) == 0

    tokened = MCPServerTask("remote")
    captured = _drive_http(tokened, {"url": "https://example.com/mcp", "headers": {"X-Team": "a"},
                                     "auth_command": argv})
    assert captured["auth"].source is tokened._auth_command_source
    # The token never enters the configured headers, so both connections hash the same inputs.
    assert not any(k.lower() == "authorization" for k in captured.get("headers") or {})
    assert tokened._resolved_identity == plain._resolved_identity
    assert plain._resolved_identity == _identity_digest(
        ["https://example.com/mcp", {"X-Team": "a"}])


def test_auth_command_and_oauth_are_exclusive(command):
    from tools.mcp_tool import MCPServerTask

    argv, _state = command
    server = MCPServerTask("remote")
    server._auth_type = "oauth"
    with pytest.raises(ValueError, match="cannot both be set"):
        _drive_http(server, {"url": "https://example.com/mcp", "auth": "oauth", "auth_command": argv})


def test_a_command_is_part_of_the_route_and_never_borrowed_across_profiles(command):
    from tools.mcp_tool_registration import _same_server_route

    argv, _state = command
    base = {"url": "https://example.com/mcp"}
    owner = MagicMock()
    owner._config, owner._resolved_identity = {**base, "auth_command": argv}, "digest"
    assert _same_server_route(owner, {**base, "auth_command": argv})
    assert not _same_server_route(owner, {**base, "auth_command": [*argv, "--other"]})
    assert not _same_server_route(owner, base)
    assert not _same_server_route(owner, {**base, "auth_command": argv}, cross_profile=True,
                                  resolved_identity="digest")
    plain = MagicMock()
    plain._config, plain._resolved_identity = dict(base), "digest"
    assert _same_server_route(plain, dict(base), cross_profile=True, resolved_identity="digest")  # as before


def test_preflight_is_none_for_servers_without_a_command():
    from tools.mcp_tool_common import _core

    with patch.dict(_core._servers, {"plain": MagicMock(), "real": MagicMock(_auth_command_source=None)}):
        assert ac.preflight_error("plain") is None
        assert ac.preflight_error("real") is None
        assert ac.preflight_error("absent") is None


# --------------------------------------------------------------------------------------------- end to end
@pytest.fixture
def gateway(tmp_path, monkeypatch, command):
    """A token-guarded HTTP MCP server and a Profile whose ``gw`` server uses the token command."""
    pytest.importorskip("mcp.server")
    pytest.importorskip("uvicorn")
    argv, cmd_state = command
    state = tmp_path / "srv"
    state.mkdir()
    script = tmp_path / "gw_server.py"
    script.write_text(HTTP_SERVER, encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(script), str(state)])
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("NO_PROXY", "*")
    try:
        deadline = time.monotonic() + 30
        while not ((state / "port").exists() and (state / "port").read_text()) and time.monotonic() < deadline:
            time.sleep(0.05)
        port = (state / "port").read_text()
        import hermes_yaml as yaml

        (home / "config.yaml").write_text(yaml.safe_dump({"mcp_servers": {"gw": {
            "url": f"http://127.0.0.1:{port}/mcp", "auth_command": argv, "connect_timeout": 20}}}), encoding="utf-8")
        yield state, cmd_state
    finally:
        from tools import mcp_tool_loop as _loop
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers

        shutdown_mcp_servers()
        _loop._stop_mcp_loop()
        proc.terminate()
        proc.wait(10)


def _requests(state: Path) -> list[list]:
    return [json.loads(line) for line in (state / "requests.log").read_text().splitlines()]


def _call() -> dict:
    from tools.registry import registry

    return json.loads(registry.dispatch("mcp__gw__whoami", {}))


def test_end_to_end_connect_refresh_401_and_failure(gateway, caplog, monkeypatch):
    from tools import mcp_tool_discovery as disc
    from tools.mcp_tool_common import _core

    srv_state, cmd_state = gateway
    caplog.set_level(logging.DEBUG)
    assert "mcp__gw__whoami" in disc.discover_mcp_tools()
    server = _core._servers["gw"]
    identity, session = server._resolved_identity, server.session
    assert identity and session is not None

    # Connect: every request carried the first token. (The content-type probe, a bare HEAD, carries no
    # credential at all, as for OAuth servers; its 401 counts as "may be an auth challenge" and passes.)
    assert _call().get("result") == "ok"
    probe, *first = _requests(srv_state)
    assert probe == ["HEAD", "", False]
    assert first and {auth for _m, auth, ok in first} == {"Bearer tok-1-s3cr3tvalue"} and all(ok for *_x, ok in first)
    assert runs(cmd_state) == 1

    # Near expiry: the next call mints before sending; no 401, no reconnect.
    server._auth_command_source._expires_at = 0.0
    assert _call().get("result") == "ok"
    assert runs(cmd_state) == 2
    calls = [r for r in _requests(srv_state) if r[0] == "tools/call"]
    assert calls[-1] == ["tools/call", "Bearer tok-2-s3cr3tvalue", True]

    # The server stops accepting the cached token: one 401, one re-mint, the call succeeds.
    (srv_state / "accept").write_text("tok-3-s3cr3tvalue")
    assert _call().get("result") == "ok"
    assert runs(cmd_state) == 3
    calls = [r for r in _requests(srv_state) if r[0] == "tools/call"]
    assert calls[-2:] == [["tools/call", "Bearer tok-2-s3cr3tvalue", False],
                          ["tools/call", "Bearer tok-3-s3cr3tvalue", True]]

    # The connection identity and the live session survived every refresh.
    assert server._resolved_identity == identity and server.session is session
    assert _core._servers["gw"] is server
    assert disc.restart_mcp_servers_with_new_inputs({"gw"}) == []

    # The command now fails and the token is spent: a clear tool error, nothing sent.
    (cmd_state / "fail").write_text("1")
    server._auth_command_source._expires_at = 0.0
    before = len(_requests(srv_state))
    error = _call()
    assert "auth_command for MCP server 'gw' exited 3" in error["error"] and error.get("server") == "gw"
    assert len(_requests(srv_state)) == before

    # A hung command is cut off by its timeout; the turn gets an error, not a hang.
    (cmd_state / "fail").unlink()
    (cmd_state / "hang").write_text("1")
    monkeypatch.setattr(ac, "_MINT_TIMEOUT_SECONDS", 1.0)
    started = time.monotonic()
    assert "timed out after 1s" in _call()["error"]
    assert time.monotonic() - started < 10

    # No token ever reached a log record.
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "s3cr3tvalue" not in logged and "tok-should-not-leak" not in logged
