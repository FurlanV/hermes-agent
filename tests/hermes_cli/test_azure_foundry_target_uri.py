"""Azure Foundry endpoints configured as the portal's "Target URI".

The Azure portal shows each deployment's full operation URL
(``https://<res>.openai.azure.com/openai/responses?api-version=…``). Pasted into
``model.base_url`` it used to reach the SDK verbatim, which appended its own operation
(``…/openai/responses/chat/completions``) → HTTP 404 on every call. These tests resolve a
real config from ``HERMES_HOME``, build the agent the way the CLI does, and assert the
URL the OpenAI client actually requests.
"""

import json

import httpx
import openai
import pytest

from hermes_constants import get_hermes_home

RESOURCE = "https://res.openai.azure.com"
API_VERSION = "2025-04-01-preview"


@pytest.fixture
def requested_urls(monkeypatch):
    urls = []

    def _record(self, request, *args, **kwargs):
        if request.url.path.endswith(("/responses", "/chat/completions")):  # not init-time metadata probes
            urls.append(str(request.url))
        return httpx.Response(404, json={"error": {"code": "404", "message": "Resource not found"}}, request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _record)
    return urls


def _write_azure_config(base_url, model, api_mode="chat_completions"):
    home = get_hermes_home()
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(json.dumps({"model": {
        "provider": "azure-foundry", "default": model, "base_url": base_url, "api_mode": api_mode}}))
    (home / ".env").write_text("AZURE_FOUNDRY_API_KEY=test-azure-key\n")


def _cli_agent(model):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from run_agent import AIAgent

    runtime = resolve_runtime_provider(requested="azure-foundry", target_model=model)
    agent = AIAgent(model=model, api_key=runtime["api_key"], base_url=runtime["base_url"],
                    provider=runtime["provider"], api_mode=runtime["api_mode"], quiet_mode=True,
                    skip_context_files=True, skip_memory=True, enabled_toolsets=[])
    return runtime, agent


def test_responses_target_uri_reaches_the_responses_operation_with_api_version(requested_urls):
    # api_mode: chat_completions is what the wizard writes; on the dated route the URL's
    # /responses operation is the only one /openai serves, so it decides the wire.
    _write_azure_config(f"{RESOURCE}/openai/responses?api-version={API_VERSION}", "gpt-6-luna")
    runtime, agent = _cli_agent("gpt-6-luna")

    assert runtime["api_mode"] == agent.api_mode == "codex_responses"
    with pytest.raises(openai.NotFoundError):
        agent.client.responses.create(model="gpt-6-luna", input="hi")
    assert requested_urls == [f"{RESOURCE}/openai/responses?api-version={API_VERSION}"]


def test_chat_target_uri_keeps_its_deployment_route_over_model_inference(requested_urls):
    # gpt-5.x would infer codex_responses, but /openai/deployments/<d> serves only chat.
    _write_azure_config(
        f"{RESOURCE}/openai/deployments/gpt-5.4/chat/completions?api-version={API_VERSION}", "gpt-5.4")
    runtime, agent = _cli_agent("gpt-5.4")

    assert runtime["api_mode"] == agent.api_mode == "chat_completions"
    with pytest.raises(openai.NotFoundError):
        agent.client.chat.completions.create(model="gpt-5.4", messages=[{"role": "user", "content": "hi"}])
    assert requested_urls == [f"{RESOURCE}/openai/deployments/gpt-5.4/chat/completions?api-version={API_VERSION}"]


def test_aux_route_from_main_runtime_keeps_api_version(requested_urls):
    # Compression / titles / background review re-resolve from the agent's runtime snapshot;
    # the client's base_url alone has lost the api-version.
    from agent.auxiliary_client import get_text_auxiliary_client

    _write_azure_config(f"{RESOURCE}/openai/responses?api-version={API_VERSION}", "gpt-6-luna")
    _, agent = _cli_agent("gpt-6-luna")

    snapshot = agent._current_main_runtime()
    assert snapshot["base_url"] == f"{RESOURCE}/openai?api-version={API_VERSION}"
    client, model = get_text_auxiliary_client("compression", main_runtime=snapshot)
    with pytest.raises(openai.NotFoundError):
        client.chat.completions.create(model=model, messages=[{"role": "user", "content": "hi"}])
    assert requested_urls == [f"{RESOURCE}/openai/responses?api-version={API_VERSION}"]
