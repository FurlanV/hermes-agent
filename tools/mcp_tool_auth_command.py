"""``auth_command``: a bearer token for an HTTP MCP server, minted by running a fixed command.

    mcp_servers:
      gateway:
        url: "https://gateway.example/mcp/eagle"
        auth_command: ["/opt/athena/bin/athena", "token"]   # argv list, run without a shell

Short-lived bearers (an SSO broker, a capability gateway) go stale within the hour, so a static
``headers: {Authorization: ...}`` cannot carry them. ``auth_command`` names a command that PRINTS a
token, with the provider ``key_cmd`` output contract (``agent/command_token_source.py``): stdout is the
token alone, or JSON with an ``access_token`` field and optionally ``expires_in`` (seconds) or an
ISO 8601 ``expiry`` / ``expiresOn``. Unlike ``key_cmd`` it is an argument list and never goes
through a shell.

- **Caching.** The token is reused until ``_REFRESH_LEEWAY_SECONDS`` before its expiry (at least
  ``_MIN_CACHE_SECONDS``); with no advertised expiry it is re-minted every ``_NO_TTL_REFRESH_SECONDS``.
- **401.** A request the server answers 401 is re-sent once with a freshly minted token (unless another
  request already replaced the rejected one). A second 401 goes back to the SDK unchanged.
- **Failure.** The command runs with a ``_MINT_TIMEOUT_SECONDS`` timeout; a non-zero exit, no output,
  several lines or JSON without ``access_token`` raise :class:`AuthCommandError`, whose text names the
  server, never the command line or its output. Before a tool call is dispatched,
  :func:`preflight_error` mints when the cached token is spent, so a failing command is a clear tool
  error instead of a transport failure mid-call.
- **Secrets.** Every token is registered for redaction (``agent.redact``: model-facing text and the
  ``RedactingFormatter`` logs) before it is used.
- **Connection identity.** The token is attached per request by an httpx ``Auth`` flow and never enters
  the configured ``headers``: ``tools.mcp_tool_transport._connect_inputs`` hashes the URL and headers into
  the connection's identity, so a refresh must not change them, or every refresh would read as new
  launch inputs and rebuild the connection. The command itself is part of the route
  (:func:`same_command`), and a connection whose token comes from a command is never adopted across
  profiles: the same argv mints a different user's token in each profile.

Without ``auth_command`` none of this runs: :func:`auth_command_argv` answers ``None`` and every caller
falls through to the code path it had before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger("tools.mcp_tool")

CONFIG_KEY = "auth_command"
_REFRESH_LEEWAY_SECONDS = 60.0
_MIN_CACHE_SECONDS = 5.0
_NO_TTL_REFRESH_SECONDS = 900.0
_MINT_TIMEOUT_SECONDS = 15.0


class AuthCommandError(RuntimeError):
    """An ``auth_command`` did not produce a usable token."""


def auth_command_argv(server_name: str, config: Any) -> Optional[list[str]]:
    """The configured argv, ``None`` when the key is absent. A string (which would need a shell), an
    empty list or a non-string item raises ``ValueError``: the server then fails to connect with that
    message instead of connecting without its credential."""
    value = config.get(CONFIG_KEY) if isinstance(config, dict) else None
    if value is None:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise ValueError(f"MCP server '{server_name}': {CONFIG_KEY} must be a non-empty list of strings "
                         "(the command and its arguments; it is run without a shell)")
    return list(value)


def _configured(config: Any) -> Optional[tuple[str, ...]]:
    """The argv as a tuple when *config* names a well-formed one, else ``None`` (never raises)."""
    value = config.get(CONFIG_KEY) if isinstance(config, dict) else None
    return tuple(value) if isinstance(value, list) and all(isinstance(v, str) for v in value) else None


def same_command(config_a: Any, config_b: Any) -> bool:
    """Whether two server configs mint their token the same way (both without ``auth_command`` included)."""
    return _configured(config_a) == _configured(config_b)


def uses_command(config: Any) -> bool:
    return _configured(config) is not None


def _parse(stdout: str, server_name: str) -> tuple[str, Optional[float]]:
    """``(token, ttl_seconds_or_None)`` from the command's stdout (the ``key_cmd`` contract)."""
    where = f"{CONFIG_KEY} for MCP server '{server_name}'"
    if not stdout.strip():
        raise AuthCommandError(f"{where} produced no output")
    if stdout.lstrip().startswith("{"):
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            token = str(payload.get("access_token") or "").strip()
            if not token:
                raise AuthCommandError(f"{where} returned JSON without an 'access_token' field")
            ttl = payload.get("expires_in")
            if isinstance(ttl, (int, float)) and not isinstance(ttl, bool) and ttl > 0:
                return token, float(ttl)
            from hermes_cli.auth import _parse_iso_timestamp  # lazy: hermes_cli.auth imports agent.*

            for field in ("expiry", "expiresOn"):
                deadline = _parse_iso_timestamp(payload.get(field))
                remaining = deadline - time.time() if deadline is not None else 0
                if remaining > 0:
                    return token, remaining
            return token, None
    token = stdout.strip()
    if "\n" in token:
        raise AuthCommandError(f"{where} printed several lines; it must print only the token "
                               "(or JSON with an 'access_token' field)")
    return token, None


def _mint(argv: list[str], server_name: str) -> tuple[str, Optional[float]]:
    """Run *argv* (no shell, stdin closed, the served profile's env) and parse its stdout."""
    from tools.environments.local import served_profile_child_env

    where = f"{CONFIG_KEY} for MCP server '{server_name}'"
    timeout = _MINT_TIMEOUT_SECONDS
    try:
        completed = subprocess.run(argv, stdin=subprocess.DEVNULL, shell=False, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=timeout, check=False,
                                   env=served_profile_child_env(inherit_credentials=True))
    except subprocess.TimeoutExpired as exc:
        raise AuthCommandError(f"{where} timed out after {timeout:g}s") from exc
    except OSError as exc:
        raise AuthCommandError(f"{where} could not be run: {exc.strerror or type(exc).__name__}") from exc
    if completed.returncode != 0:
        # Never stdout/stderr (they may hold a token) nor the argv (it may embed a secret).
        raise AuthCommandError(f"{where} exited {completed.returncode}; run it by hand to see why "
                               "(a signed-out session is the usual cause)")
    return _parse(completed.stdout or "", server_name)


class AuthCommandToken:
    """One server's token source: minted on demand, cached until shortly before expiry, thread-safe."""

    def __init__(self, server_name: str, argv: list[str], *, clock: Callable[[], float] = time.monotonic) -> None:
        self.server_name = server_name
        self.argv = list(argv)
        self._clock = clock
        self._lock = threading.Lock()
        self._token = ""
        self._expires_at = 0.0
        self.mints = 0
        self.last_error: Optional[str] = None

    def _mint_locked(self) -> str:
        try:
            token, ttl = _mint(self.argv, self.server_name)
        except AuthCommandError as exc:
            self.last_error = str(exc)
            raise
        from agent.redact import register_vault_redaction_value

        register_vault_redaction_value(token)  # before any use: logs and model-facing text scrub it
        self.mints += 1
        self.last_error = None
        self._token = token
        lifetime = max(ttl - _REFRESH_LEEWAY_SECONDS, _MIN_CACHE_SECONDS) if ttl else _NO_TTL_REFRESH_SECONDS
        self._expires_at = self._clock() + lifetime
        logger.debug("MCP server '%s': %s minted a token (ttl=%s)", self.server_name, CONFIG_KEY,
                     f"{int(ttl)}s" if ttl else "unknown")
        return token

    def token(self) -> str:
        """The cached token, or a fresh one when it is spent. Raises :class:`AuthCommandError`."""
        with self._lock:
            if self._token and self._clock() < self._expires_at:
                return self._token
            return self._mint_locked()

    def refresh_after_401(self, rejected: str) -> Optional[str]:
        """A token to re-send with after *rejected* drew a 401: the current one when another request has
        already replaced it, else a fresh mint. ``None`` when the command fails (logged, never raised:
        the 401 then stands)."""
        with self._lock:
            if self._token and self._token != rejected and self._clock() < self._expires_at:
                return self._token
            self._token, self._expires_at = "", 0.0
            try:
                return self._mint_locked()
            except AuthCommandError as exc:
                logger.warning("MCP server '%s': the server refused the token (401) and %s", self.server_name,
                               str(exc).replace(f"{CONFIG_KEY} for MCP server '{self.server_name}' ",
                                                f"{CONFIG_KEY} "))
                return None


def source_for(server: Any, config: dict) -> Optional[AuthCommandToken]:
    """The server task's token source for *config* (kept across reconnects while the argv is unchanged),
    or ``None`` without ``auth_command``. Raises ``ValueError`` on a malformed one."""
    argv = auth_command_argv(server.name, config)
    if argv is None:
        if getattr(server, "_auth_command_source", None) is not None:  # the key was removed from the config
            server._auth_command_source = None
        return None
    current = getattr(server, "_auth_command_source", None)
    if not isinstance(current, AuthCommandToken) or current.argv != argv:
        current = server._auth_command_source = AuthCommandToken(server.name, argv)
    return current


_AUTH_CLASSES: dict[int, type] = {}


def httpx_auth(httpx_mod: Any, source: AuthCommandToken) -> Any:
    """An ``httpx_mod.Auth`` (the SDK's own httpx, ``httpx2`` on mcp 2.x) that sets
    ``Authorization: Bearer <token>`` on every request and re-sends once after a 401."""
    cls = _AUTH_CLASSES.get(id(httpx_mod))
    if cls is None:
        cls = _AUTH_CLASSES[id(httpx_mod)] = _make_auth_class(httpx_mod)
    return cls(source)


def _make_auth_class(httpx_mod: Any) -> type:
    class AuthCommandAuth(httpx_mod.Auth):  # type: ignore[misc, name-defined]
        requires_request_body = True  # the 401 retry re-sends the body

        def __init__(self, source: AuthCommandToken) -> None:
            self.source = source

        @staticmethod
        def _set(request: Any, token: str) -> None:
            request.headers["Authorization"] = f"Bearer {token}"

        def sync_auth_flow(self, request: Any):  # type: ignore[no-untyped-def]
            token = self.source.token()
            self._set(request, token)
            response = yield request
            if response.status_code == 401:
                fresh = self.source.refresh_after_401(token)
                if fresh is not None:
                    self._set(request, fresh)
                    yield request

        async def async_auth_flow(self, request: Any):  # type: ignore[no-untyped-def]
            # Off the MCP event loop: a mint may block for up to the command's timeout.
            token = await asyncio.to_thread(self.source.token)
            self._set(request, token)
            response = yield request
            if response.status_code == 401:
                fresh = await asyncio.to_thread(self.source.refresh_after_401, token)
                if fresh is not None:
                    self._set(request, fresh)
                    yield request

    return AuthCommandAuth


def preflight_error(server_name: str) -> Optional[str]:
    """Before a tool call: a ``tool_error`` when the server's ``auth_command`` cannot produce a token, else
    ``None`` (always ``None`` for a server without one). A spent token is minted here, on the caller's
    thread and bounded by the command timeout, so the call itself goes out with a fresh one."""
    from tools.mcp_tool_common import _core
    from tools.mcp_tool_scope import _resolve_server_key

    with _core._lock:
        server = _core._servers.get(_resolve_server_key(server_name))
    source = getattr(server, "_auth_command_source", None) if server is not None else None
    if not isinstance(source, AuthCommandToken):
        return None
    try:
        source.token()
    except AuthCommandError as exc:
        from tools.registry import tool_error

        return tool_error(f"{exc}. The call was not sent. Do not retry until the user has fixed the sign-in.",
                          server=server_name)
    return None
