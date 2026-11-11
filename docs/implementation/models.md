# Local and cloud models through Pi

Pify remains a bootstrap project. Its private package adds no model catalog, provider wrapper, credential store, or required local service. Pi owns model selection. Pify's package smoke tests exercise an OpenAI-compatible local endpoint and Anthropic's Messages protocol through Pi's normal selection path.

## Local endpoint: LM Studio

This setup covers LM Studio's default server with API authentication off. Start its server on loopback, then read the model IDs it exposes:

```sh
lms server start --bind 127.0.0.1 --port 1234
curl http://127.0.0.1:1234/v1/models
```

Choose an actual `data[].id` from that response. Add this provider to your Pi agent directory's `models.json` (`~/.pi/agent/models.json` by default). If the file exists, merge the provider entry into it; preserve your other providers and settings. Replace the placeholder ID and context length with values supported by your loaded model:

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "models": [
        { "id": "<ID_FROM_SERVER>", "contextWindow": 8192, "maxTokens": 1024 }
      ]
    }
  }
}
```

The dummy `apiKey` makes this unauthenticated compatible endpoint selectable in Pi. The shown context length is the value used in one local test, not a claim about other models. Pi 1.4.0 sent only one completion token when that test declared a 4,096-token context; it sent the requested 1,024-token budget and received a complete reply at 8,192. Match the declared length to the model's actual load setting. Select it with Pi's `/model` menu or `pi --provider lmstudio --model '<ID_FROM_SERVER>'`.

## Cloud provider: Anthropic

Use Pi's `/login` flow and choose Anthropic, or set `ANTHROPIC_API_KEY` before starting Pi. Keep credentials out of Pify and project files. Select an available Anthropic model with Pi's `/model` menu; Pi also accepts `--provider anthropic --model '<ID_FROM_PI>'`. Pify does not pin a live cloud model ID.

The CI fixture selects `anthropic` through Pi's RPC `set_model`, sends a prompt through the Messages protocol, and checks the response. It uses a loopback protocol server and a fixture key; it does not call Anthropic's live service. A live account and credential are required to verify the hosted path on a user's machine.

## Private hosted-model validation through LiteLLM

An owner with a LiteLLM virtual key and one hosted chat model can run this optional check from the repository with Pi 1.5.2 on `PATH`:

```sh
python3 scripts/smoke_pi_models.py --live-litellm
```

The command prompts for the LiteLLM OpenAI-compatible base URL ending in `/v1`, the exact model alias exposed by the proxy, and the virtual key. Key input is hidden. The command installs the private Pify package only into a temporary Pi agent directory, writes a temporary `models.json` that refers to the key through an environment variable, sends one short prompt through Pi, checks `/pify-health`, and removes the fixture. It does not use or change the active Pi directory. A non-loopback endpoint must use HTTPS. The output contains status, gateway, protocol, Pi version, and platform; it excludes the key, URL, model alias, and response text.

A passing response proves that Pi can use the selected LiteLLM API route. LiteLLM owns upstream provider and model routing; Pify does not configure or inspect that backend. For the MVP cloud gate, the owner confirms only that the tested route reaches a hosted model. The live command is not run in CI and must not be run with a key in a shell argument, repository file, or issue comment. Record only redacted evidence in the MVP gate issue. The ordinary fixture smoke also exercises this validation path against a loopback server with a dummy key.

An owner-run check passed on macOS with Pi 1.4.0 on 2026-11-06, using a route the owner confirmed was hosted. The [redacted evidence](https://github.com/fnayou/pify/issues/81#issuecomment-6672093689) contains no endpoint, key, model alias, or upstream provider configuration. This is one platform's live result, not a release claim.

### Hosted model inside the reviewed Git setup candidate

The optional live GitHub smoke can test the same hosted route after it previews and installs an exact public Git commit into disposable fresh and existing Pi agents:

```sh
PIFY_REVIEWED_COMMIT=9faefeb17b55d6ec15d078eaa1325ee36bb8bab2
python3 scripts/smoke_pi_live_github.py "$PIFY_REVIEWED_COMMIT" --live-litellm
```

The commit above passed the [public-GitHub source smoke](https://github.com/fnayou/pify/actions/runs/43119841151) under Pi 1.5.2 on macOS and Linux. Use Pi 1.5.2 on `PATH`. The command checks Pi's version before asking for a secret, then prompts in a terminal for the LiteLLM `/v1` base URL, model alias, and virtual key; all three inputs are hidden. It rejects a noninteractive terminal and non-HTTPS remote URL. In the existing-user fixture it adds a temporary model entry with an environment-variable key reference, selects the model through Pi RPC, checks a one-use reply and `/pify-health`, restores the prior `models.json` bytes, then completes TUI startup and native removal. Its JSON result contains only status, gateway, protocol, Git commit, Pi version, platform, and journey. Do not paste a key into the command, repository, or issue tracker.

The integrated path passed on macOS with a loopback LiteLLM-compatible fixture and dummy key on 2026-11-11 against commit `df4477650e2580bed2c001e52b78641d62c404bc`. Reproduce it without a real key using `python3 scripts/smoke_pi_live_github_litellm_fixture.py df4477650e2580bed2c001e52b78641d62c404bc`; this still fetches the public GitHub commit and uses only temporary Pi state. The [Pi 1.5.2 live-source run](https://github.com/fnayou/pify/actions/runs/43119841151) passed on macOS and Linux against the current reviewed commit. Neither run proves a hosted call. The owner must run `--live-litellm` with a real hosted route and record only the redacted result in [MVP gate #81](https://github.com/fnayou/pify/issues/81). The earlier standalone hosted result remains separate evidence until then.

## Availability and evidence

Stopping LM Studio makes that local endpoint unavailable. It does not block Pi's cloud model selection or Pify's `/pify-health` command. The CI fixture stops its local endpoint, then completes an Anthropic-protocol prompt and a health check. The same smoke runs on macOS and Linux with the exact CI-pinned Pi version. A separate macOS test used a real LM Studio server and a locally loaded model at an 8,192-token context; Pi returned `READY`. Pify's package does not download models or edit `models.json`.

Sources: [Pi model selection and compatible endpoints](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/models.md), [Pi model configuration](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/models-configuration.md), [Pi provider authentication](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/providers.md), [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), [LM Studio model listing](https://lmstudio.ai/docs/developer/openai-compat/models), [LiteLLM gateway quickstart](https://docs.litellm.ai/docs/proxy/docker_quick_start).
