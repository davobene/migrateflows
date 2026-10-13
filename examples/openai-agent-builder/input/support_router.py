from agents import WebSearchTool, FileSearchTool, HostedMCPTool, Agent, ModelSettings, TResponseInputItem, Runner, RunConfig, trace
from openai import AsyncOpenAI
from types import SimpleNamespace
from guardrails.runtime import load_config_bundle, instantiate_guardrails, run_guardrails
from openai.types.shared.reasoning import Reasoning
from pydantic import BaseModel

# Tool definitions
file_search = FileSearchTool(
  vector_store_ids=[
    "vs_example_help_center"
  ]
)
web_search_preview = WebSearchTool(
  search_context_size="medium",
  user_location={
    "type": "approximate"
  }
)
mcp = HostedMCPTool(tool_config={
  "type": "mcp",
  "server_label": "orders",
  "server_url": "https://orders.example.com/mcp",
  "allowed_tools": [
    "get_order_status"
  ],
  "require_approval": "never"
})

# Shared client for guardrails and file search
client = AsyncOpenAI()
ctx = SimpleNamespace(guardrail_llm=client)
# Guardrails definitions
jailbreak_guardrail_config = {
  "guardrails": [
    { "name": "Jailbreak", "config": { "model": "gpt-4.1-mini", "confidence_threshold": 0.7 } },
    { "name": "Contains PII", "config": { "block": True, "entities": ["CREDIT_CARD", "EMAIL_ADDRESS"] } }
  ]
}
def guardrails_has_tripwire(results):
    return any(getattr(r, "tripwire_triggered", False) is True for r in (results or []))

class ClassifierSchema(BaseModel):
  topic: str

classifier = Agent(
  name="Classifier",
  instructions="""Classify the customer message into one topic: "orders" for order status and shipping, "product" for questions about the product, "other" for anything else.""",
  model="gpt-4.1-mini",
  output_type=ClassifierSchema,
  model_settings=ModelSettings(
    temperature=0,
    store=True
  )
)

orders_agent = Agent(
  name="Orders agent",
  instructions="You help customers with their orders. Use the orders tool to look up the status. Be brief.",
  model="gpt-4.1",
  tools=[
    mcp
  ],
  model_settings=ModelSettings(
    temperature=0.3,
    store=True
  )
)

product_agent = Agent(
  name="Product expert",
  instructions="Answer product questions using the help center documents first and the web only when the documents do not cover it.",
  model="gpt-5",
  tools=[
    file_search,
    web_search_preview
  ],
  model_settings=ModelSettings(
    store=True,
    reasoning=Reasoning(
      effort="low",
      summary="auto"
    )
  )
)


class WorkflowInput(BaseModel):
  input_as_text: str


# Main code entrypoint
async def run_workflow(workflow_input: WorkflowInput):
  with trace("Support router"):
    state = {}
    workflow = workflow_input.model_dump()
    conversation_history: list[TResponseInputItem] = [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": workflow["input_as_text"]
          }
        ]
      }
    ]
    guardrails_inputtext = workflow["input_as_text"]
    guardrails_result = await run_guardrails(ctx, guardrails_inputtext, "text/plain", instantiate_guardrails(load_config_bundle(jailbreak_guardrail_config)), suppress_tripwire=True)
    guardrails_hastripwire = guardrails_has_tripwire(guardrails_result)
    if guardrails_hastripwire:
      return {
        "message": "Sorry, I can't help with that request."
      }
    else:
      classifier_result_temp = await Runner.run(
        classifier,
        input=[
          {
            "role": "user",
            "content": [
              {
                "type": "input_text",
                "text": workflow["input_as_text"]
              }
            ]
          }
        ],
        run_config=RunConfig(trace_metadata={
          "__trace_source__": "agent-builder",
          "workflow_id": "wf_example_support_router"
        })
      )
      classifier_result = {
        "output_text": classifier_result_temp.final_output.json(),
        "output_parsed": classifier_result_temp.final_output.model_dump()
      }
      if classifier_result["output_parsed"]["topic"] == "orders":
        orders_agent_result_temp = await Runner.run(
          orders_agent,
          input=[
            *conversation_history
          ],
          run_config=RunConfig(trace_metadata={
            "__trace_source__": "agent-builder",
            "workflow_id": "wf_example_support_router"
          })
        )
        conversation_history.extend([item.to_input_item() for item in orders_agent_result_temp.new_items])
        orders_agent_result = {
          "output_text": orders_agent_result_temp.final_output_as(str)
        }
        return orders_agent_result
      elif classifier_result["output_parsed"]["topic"] == "product":
        product_agent_result_temp = await Runner.run(
          product_agent,
          input=[
            *conversation_history
          ],
          run_config=RunConfig(trace_metadata={
            "__trace_source__": "agent-builder",
            "workflow_id": "wf_example_support_router"
          })
        )
        conversation_history.extend([item.to_input_item() for item in product_agent_result_temp.new_items])
        product_agent_result = {
          "output_text": product_agent_result_temp.final_output_as(str)
        }
        return product_agent_result
      else:
        return {
          "message": "Thanks! A person from our team will get back to you."
        }
