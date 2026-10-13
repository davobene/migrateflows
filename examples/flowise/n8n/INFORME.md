# Flowise → n8n conversion report

Each Flowise flow was converted into one or more n8n workflows ready to import (Workflows → Import from File). Below is what was done and what still needs a look.

## Travel agent

Coverage: 100% · Generated workflows: `Travel_agent.n8n.json`

**Review**

- Tool "get_weather": the code moved to a Code Tool node. Parameters arrive in "query" and were copied into Flowise's $name variables. Test it with a real message.

**Done**

- Memory uses n8n's chat session (sessionId).

**Credentials to create in n8n**

- Create a "OpenAI" credential and select it in "OpenAI Chat Model".

## Support bot

Coverage: 100% · Generated workflows: `Support_bot.n8n.json`, `Support_bot_document_loading.n8n.json`

**Review**

- Vector store "In-Memory Vector Store" was in-memory or local (memoryVectorStore). In n8n it became "Simple Vector Store" with key "flowise_support_bot": run the document loading workflow first. It is cleared when n8n restarts; for production use Qdrant, Pinecone, Supabase or Postgres.
- The conversational retrieval QA chain became an AI Agent with the vector store as a tool. The agent decides when to search; the system message tells it to always search.

**Done**

- "Text File": the content of faq.txt was inside the export and now lives in a Code node of the loading workflow.
- Generated workflow "Support bot – document loading" to load documents into the vector store.
- Flowise's rephrase prompt is not used: the agent rephrases on its own.
- Memory uses n8n's chat session (sessionId).

**Credentials to create in n8n**

- Create a "OpenAI" credential and select it in "OpenAI Chat Model".
- Create a "OpenAI" credential and select it in "Embeddings OpenAI".
- Create a "OpenAI" credential and select it in "Support bot – document loading › Embeddings OpenAI".

## Ticket triage

Coverage: 100% · Generated workflows: `Ticket_triage.n8n.json`

**Review**

- Flow state ($flow.state) is kept in a Set node at the start; later updates are read from the node that produced them.

**Credentials to create in n8n**

- Create a "OpenAI" credential and select it in "OpenAI Chat Model".
- Create a "Anthropic" credential and select it in "Anthropic Chat Model".
- Create a "OpenAI" credential and select it in "OpenAI Chat Model 2".
