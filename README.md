# MigrateFlows

Free converters that turn workflows from tools that are shutting down into n8n workflows you can import.

| From | Why now | Converter |
|---|---|---|
| OpenAI Agent Builder | Shuts down November 30, 2026 | [migrateflows.com/openai-agent-builder-to-n8n](https://migrateflows.com/openai-agent-builder-to-n8n/) |
| Flowise | Archived, no more security fixes | [migrateflows.com/flowise-to-n8n](https://migrateflows.com/flowise-to-n8n/) |
| Pipedream Workflows | Shuts down March 31, 2027 | [migrateflows.com](https://migrateflows.com/) |

Everything runs in the browser: your export never leaves your computer. This repo has the full source, so you can check that or run it yourself.

[Leer en castellano](README.es.md)

## What it converts

**OpenAI Agent Builder** (input: the code export, *Code → Agents SDK*, Python or TypeScript)
- Each agent becomes an n8n AI Agent with its model, instructions (static or per-request), output schema and memory.
- Web search, file search and code interpreter stay as OpenAI built-in tools through n8n's OpenAI model, so vector store IDs keep working.
- MCP servers become MCP Client tools. Tokens found in the code are never copied: the report tells you which credential to create.
- Guardrails become n8n's Guardrails node. if/elif/else and classifiers become Switch, while loops become If with a loop back, user approval becomes Wait with a form.

**Flowise** (input: a chatflow/agentflow export, or *Settings → Export → All*)
- Chains and agents: LLM Chain, Conversation Chain, Retrieval QA, Tool Agent, ReAct, supervisor/worker teams.
- Chat models (OpenAI, Anthropic, Gemini, Mistral, Ollama, Groq, Azure and more), memory, splitters, output parsers.
- Vector stores keep pointing to the same index (Pinecone, Qdrant, Supabase, Postgres, Chroma...), so nothing has to be re-embedded.
- Custom tools run in n8n's Code Tool. Document Stores come along from *Export All*.
- Agentflow v2 nodes: LLM, Agent, Condition, Condition Agent, HTTP, Custom Function, Iteration, Loop, Direct Reply, Human Input.

**Pipedream** (input: the project export or a GitHub Sync folder)
- Node.js code steps become Code nodes, including `steps.X.$return_value`, `$.export`, `$.flow.exit`, `$.respond` and `axios` from `@pipedream/platform`.
- HTTP, webhook and schedule triggers, delays, filters (continue or end based on a condition), HTTP responses and data stores.
- Common app actions become HTTP Request nodes with the matching n8n credential: Google Sheets, Gmail, Slack, Airtable, OpenAI, Telegram, Discord, GitHub, Outlook, Teams, Google Calendar, SendGrid, Postgres, Supabase, Twilio, Snowflake.

Every conversion comes with a checklist of what is left to do by hand (credentials to reconnect, variables to create).

**Pipedream data stores** are not in the official export and are deleted on April 30, 2027. [`src/pipedream-datastore-exporter.mjs`](src/pipedream-datastore-exporter.mjs) is a read-only Pipedream code step that downloads every record as a `.datastore.json` file; drop it next to your export and the converted n8n workflows come preloaded with the data. Step-by-step: [migrateflows.com/guide/export-pipedream-data-stores](https://migrateflows.com/guide/export-pipedream-data-stores/).

## How it was tested

- Agent Builder: 196 real exports people published on GitHub → 196 workflows (437 agents). All pass n8n's own workflow validator and import.
- Flowise: the 51 Flowise marketplace templates → 55 workflows. All pass the validator and import; the main patterns were run live in n8n.
- Pipedream: 75 public GitHub Sync workflows import without errors; 437 of 438 code steps compile (the remaining one is broken in the original).

## Run it locally

Use the website, or the command line (Node.js 18+):

```
cd src
npm install
node agentbuilder-cli.js <export-folder-or-file> <output-folder> en
node flowise-cli.js <export.json|folder|zip> <output-folder> en
node cli.js <pipedream-export-folder|zip|json> <output-folder> en
```

Each run writes one `.n8n.json` file per workflow plus a report. To serve the website yourself: `npx serve site`.

The [examples](examples) folder has sample inputs (written for this project, not anyone's data) and the n8n workflows they produce.

## What doesn't convert yet

- Agent Builder: function tools come out as Code Tool stubs (the export doesn't include their code); OpenAI connectors (Gmail, Drive) must be swapped for n8n nodes; moderation and hallucination guardrails have no n8n equivalent.
- Flowise: sequential agents (Agentflow v1) and some integration tools.
- Pipedream: Python steps are beta; less common app actions become a checklist item.

If something breaks, open an issue with the export (remove anything private first) or write to hello@migrateflows.com.

## License

MIT. MigrateFlows is independent and not affiliated with OpenAI, FlowiseAI, Pipedream, Workday or n8n.
