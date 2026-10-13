# Agent Builder → n8n conversion report

Each Agent Builder code export (Agents SDK) was converted into an n8n workflow ready to import (Workflows → Import from File). Below is what was done and what still needs a look.

## Refund approvals

Coverage: 95% · `Refund_approvals.n8n.json` (refund_approval.ts)

**Manual**

- Tool "lookupOrder" was a client-side function with no implementation in the export. A Code Tool with its schema was created: write what it does.

**Review**

- Human approval became a Wait node with a form (Approve/Reject).

**Done**

- 2 agents became AI Agent nodes with their model, instructions and tools.
- The if/else at line 79 became a Switch node (2 outputs).
- Agents that shared the conversation history share one memory per chat session.
- Each "return" became a Set node with the output field (what the chat shows).

**Credentials to create in n8n**

- Create a "OpenAI" credential and select it in "Refund checker model".
- Create a "OpenAI" credential and select it in "Reply writer model".

## Support router

Coverage: 100% · `Support_router.n8n.json` (support_router.py)

**Done**

- 3 agents became AI Agent nodes with their model, instructions and tools.
- Guardrails (Jailbreak, Contains PII) → n8n Guardrails node: output 0 = pass, output 1 = blocked.
- MCP server "orders" → MCP Client Tool node (https://orders.example.com/mcp).
- "Product expert": file search (vs_example_help_center), web search became built-in tools of the OpenAI model (Responses API). Vector stores stay in your OpenAI account: use the same API key or project.
- The if/else at line 138 became a Switch node (3 outputs).
- Agents that shared the conversation history share one memory per chat session.
- Each "return" became a Set node with the output field (what the chat shows).

**Credentials to create in n8n**

- Create a "OpenAI" credential and select it in "Guardrails model".
- Create a "OpenAI" credential and select it in "Classifier model".
- Create a "OpenAI" credential and select it in "Orders agent model".
- Create a "OpenAI" credential and select it in "Product expert model".
