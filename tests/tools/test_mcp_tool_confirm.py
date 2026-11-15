"""``mcp_servers.<name>.tools.confirm``: tools that ask the user before every call.

A listed tool is gated on every call whatever the server's trust tier and its ``readOnlyHint``, and no
remembered Session or Always answer, YOLO or ``approvals.mode: off`` skips it. Its card offers only
Run (once) and Reject, so an answer never covers a later call, and it shows the server's own description
of the tool. Unlisted tools, and servers without the key, behave as before.
"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.session_context import clear_session_vars, set_session_vars
from tools import approval, mcp_tool
from tools import mcp_tool_handlers as handlers
from tools import mcp_tool_registration as registration
from tools.approval_context import reset_current_session_key, set_current_session_key

DESCRIPTION = ("Asks EAGLE to download one public paper it does not hold, add it to EAGLE and extract it. "
               "Requires the user's approval of that paper first.")


@pytest.fixture(autouse=True)
def _isolated_state(monkeypatch):
    monkeypatch.setattr(approval, "_session_approved", {})
    monkeypatch.setattr(approval, "_permanent_approved", set())
    monkeypatch.setattr(approval, "_permanent_approved_by_home", {})
    monkeypatch.setattr(approval, "_permanent_baseline_by_home", {})
    with patch.dict(mcp_tool._server_trust_levels, {}, clear=True), \
         patch.dict(mcp_tool._tool_read_only_hints, {}, clear=True), \
         patch.dict(mcp_tool._server_cost_policies, {}, clear=True), \
         patch.dict(mcp_tool._server_confirm_tools, {}, clear=True):
        yield


def _tool(name, read_only=None, description=""):
    annotations = None if read_only is None else {"readOnlyHint": read_only}
    return SimpleNamespace(name=name, description=description, inputSchema={}, annotations=annotations)


def _record(config, tools):
    registration._record_tool_trust_metadata("srv", config, tools)


class _Chat:
    """A messaging chat answering every approval card it is sent with ``choice``."""

    def __init__(self, session_key, choice):
        self.session_key, self.choice, self.cards = session_key, choice, []

    def __enter__(self):
        self._vars = set_session_vars(platform="telegram", session_key=self.session_key)
        self._key = set_current_session_key(self.session_key)
        approval.register_gateway_notify(self.session_key, self._answer)
        return self

    def __exit__(self, *exc):
        approval.unregister_gateway_notify(self.session_key)
        reset_current_session_key(self._key)
        clear_session_vars(self._vars)

    def _answer(self, data):
        self.cards.append(dict(data))
        approval.resolve_gateway_approval(self.session_key, self.choice, request_id=data["request_id"])


def _fake_run_on_mcp_loop(coro_or_factory, timeout=30):
    coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
    loop = asyncio.new_event_loop()
    try:
        async def _run():
            for srv in list(mcp_tool._servers.values()):
                if getattr(srv, "_rpc_lock", None) is None:
                    srv._rpc_lock = asyncio.Lock()
            return await coro
        return loop.run_until_complete(_run())
    finally:
        loop.close()


@pytest.fixture
def session():
    """A fake connected ``srv`` whose every call answers ``ok``."""
    fake = MagicMock()
    fake.call_tool = AsyncMock(return_value=SimpleNamespace(
        content=[SimpleNamespace(type="text", text="ok")], isError=False, structuredContent=None))
    with patch.dict(mcp_tool._servers, {"srv": SimpleNamespace(session=fake, _rpc_lock=None)}), \
         patch("tools.mcp_tool_loop._run_on_mcp_loop", side_effect=_fake_run_on_mcp_loop), \
         patch.dict(mcp_tool._server_error_counts, {}, clear=True):
        yield fake


CONFIRM = {"trust": "untrusted", "tools": {"confirm": ["ingest"]}}


def test_approving_sends_the_call_and_rejecting_or_no_answer_sends_nothing(session):
    _record(CONFIRM, [_tool("ingest", read_only=False, description=DESCRIPTION)])
    handler = handlers._make_tool_handler("srv", "ingest", 30.0)
    with _Chat("tg:approve", "once"):
        assert json.loads(handler({"id": "PMID:1"})) == {"result": "ok"}
    assert session.call_tool.await_count == 1
    for answer in ("decline", "cancel"):  # reject, and a closed card or a timeout
        with patch("tools.approval_prompt.request_elicitation_consent", return_value=answer):
            raw = handler({"id": "PMID:2"})
        assert "did not approve" in json.loads(raw)["error"]
    assert session.call_tool.await_count == 1


def test_every_call_asks_again_and_the_card_offers_only_run_and_reject():
    _record(CONFIRM, [_tool("ingest", read_only=False, description=DESCRIPTION)])
    with _Chat("tg:twice", "always") as chat:  # a stale broader answer covers this one call only
        assert handlers._trust_gate_check("srv", "ingest", args={"id": "PMID:1"}) is None
        assert handlers._trust_gate_check("srv", "ingest", args={"id": "PMID:1"}) is None
    assert len(chat.cards) == 2
    assert all(c["allow_session"] is False and c["allow_permanent"] is False for c in chat.cards)
    assert approval._session_approved == {} and approval._permanent_approved == set()


def test_the_card_shows_the_tools_description_and_the_arguments():
    _record(CONFIRM, [_tool("ingest", read_only=False, description=DESCRIPTION)])
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="decline") as consent:
        handlers._trust_gate_check("srv", "ingest", args={"id": "PMID:28191889", "title": "SHANK3 point mutations"})
    message = consent.call_args.args[0]
    assert "download one public paper" in message and "extract it" in message
    assert '"id": "PMID:28191889"' in message and "SHANK3 point mutations" in message
    assert consent.call_args.kwargs["remember_key"] is None
    assert len(message) < 2_000


def test_a_long_or_hostile_description_is_bounded_and_escaped():
    hostile = "Download it.‮" + "x" * 5_000
    _record(CONFIRM, [_tool("ingest", description=hostile)])
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="decline") as consent:
        handlers._trust_gate_check("srv", "ingest", args={"id": "1"})
    message = consent.call_args.args[0]
    assert "‮" not in message and len(message) < 2_000


@pytest.mark.parametrize("trust,read_only", [("untrusted", True), ("full", False), (None, True)])
def test_a_listed_tool_asks_whatever_its_annotation_and_the_servers_trust(trust, read_only):
    config = {"tools": {"confirm": ["ingest"]}, **({"trust": trust} if trust else {})}
    _record(config, [_tool("ingest", read_only=read_only)])
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="decline") as consent:
        assert handlers._trust_gate_check("srv", "ingest") is not None
    consent.assert_called_once()


def test_no_remembered_grant_yolo_or_approvals_off_skips_a_listed_tool(monkeypatch):
    _record(CONFIRM, [_tool("ingest")])
    monkeypatch.setattr(handlers, "_trust_granted", lambda server, tool: True)
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="accept") as consent:
        assert handlers._trust_gate_check("srv", "ingest") is None
    consent.assert_called_once()


def test_unlisted_tools_and_servers_without_the_key_behave_as_before():
    _record(CONFIRM, [_tool("ingest"), _tool("search", read_only=True)])
    with patch("tools.approval_prompt.request_elicitation_consent") as consent:
        assert handlers._trust_gate_check("srv", "search") is None
    consent.assert_not_called()
    _record({"trust": "full"}, [_tool("ingest")])
    assert "srv" not in mcp_tool._server_confirm_tools
    with patch("tools.approval_prompt.request_elicitation_consent") as consent:
        assert handlers._trust_gate_check("srv", "ingest") is None
    consent.assert_not_called()


def test_a_malformed_confirm_value_is_ignored_with_a_warning(caplog):
    _record({"trust": "full", "tools": {"confirm": {"ingest": True}}}, [_tool("ingest")])
    assert "srv" not in mcp_tool._server_confirm_tools
    assert "tools.confirm" in caplog.text
