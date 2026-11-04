# Local and cloud models through Pi

Pify remains a bootstrap project. Its private package adds no model catalog, provider wrapper, credential store, or required local service. Pi 1.4.0 owns model selection. Pify's package smoke tests exercise an OpenAI-compatible local endpoint and Anthropic's Messages protocol through Pi's normal selection path.

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

## Availability and evidence

Stopping LM Studio makes that local endpoint unavailable. It does not block Pi's cloud model selection or Pify's `/pify-health` command. The CI fixture stops its local endpoint, then completes an Anthropic-protocol prompt and a health check. The same smoke runs on macOS and Linux with Pi 1.4.0. A separate macOS test used a real LM Studio server and a locally loaded model at an 8,192-token context; Pi returned `READY`. Pify's package does not download models or edit `models.json`.

Sources: [Pi model selection and compatible endpoints](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md), [Pi provider authentication](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/providers.md), [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), [LM Studio model listing](https://lmstudio.ai/docs/developer/openai-compat/models).
