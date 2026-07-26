# OpenRouter Cost Report

Date: 2026-07-19. Pricing pulled live from the OpenRouter models API on this date. All figures are for the full product (both participants) running every single day.

## Who calls OpenRouter, and how often

| Consumer | Calls/day | Input tokens/call | Output tokens/call | Daily tokens |
|---|---|---|---|---|
| System 2 extraction (1 per person per resolved day) | 2 | ~1,200 (system prompt + day bundle) | ~500 (JSON observations) | 2,400 in / 1,000 out |
| Supermemory memory agent (1 per ingested observation document; ~6 observations per person per day) | ~12 | ~800 | ~300 | 9,600 in / 3,600 out |
| Supermemory dreaming/profile jobs (periodic batch) | ~2 | ~2,000 | ~500 | 4,000 in / 1,000 out |
| System 3 prompt generation (future, one shared prompt) | 1 | ~3,000 (memory context both people) | ~150 | 3,000 in / 150 out |
| **Total (Systems 2 + Supermemory)** | ~16 | | | **~16,000 in / ~5,600 out** |
| **Total once System 3 ships** | ~17 | | | **~19,000 in / ~5,750 out** |

Monthly (30 days, with System 3): **~0.58M input + ~0.17M output tokens**.

## Monthly cost by model (live prices per 1M tokens)

| Model | Input $/M | Output $/M | Est. monthly cost |
|---|---|---|---|
| google/gemini-2.5-flash-lite | $0.10 | $0.40 | **~$0.13** |
| openai/gpt-4o-mini | $0.15 | $0.60 | ~$0.19 |
| deepseek/deepseek-chat-v3.1 | $0.25 | $0.95 | ~$0.31 |
| google/gemini-2.5-flash (current default) | $0.30 | $2.50 | **~$0.61** |
| openai/gpt-5-mini | $0.25 | $2.00 | ~$0.49 |
| anthropic/claude-haiku-4.5 | $1.00 | $5.00 | ~$1.44 |

Even with a 5x safety margin on every token estimate, the current default stays around **$3/month**; realistically well under $1.

## The 402 gotcha (why it broke with a near-zero balance)

OpenRouter rejects a request up front unless your balance covers the request's `max_tokens` ceiling, not its actual expected usage. Supermemory's memory agent requests up to 65,535 output tokens, which prices out at roughly $0.16 per request on gemini-2.5-flash. So the practical rule is: **keep the balance above about $1 at all times**, or every Supermemory ingest fails with 402 regardless of true spend.

## Recommendation

- Top up **$10**: covers roughly a year of everything (Systems 2 + 3 + Supermemory) on the current default model with generous margin, and keeps the balance far above the 402 floor for the foreseeable future.
- Keep `google/gemini-2.5-flash` as the extraction default. If cost ever matters, `gemini-2.5-flash-lite` is the drop to make (roughly 5x cheaper), one line in config.
- Spot-check actuals after the first soak week at openrouter.ai/activity; update this report if reality diverges from the estimates.
