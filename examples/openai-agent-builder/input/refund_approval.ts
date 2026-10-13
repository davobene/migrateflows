import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";

// Tool definitions
const lookupOrder = tool({
  name: "lookupOrder",
  description: "Get an order by its number",
  parameters: z.object({
    orderNumber: z.string()
  }),
  execute: async (input: {orderNumber: string}) => {
    // TODO: Unimplemented
  },
});
const RefundCheckSchema = z.object({ eligible: z.boolean(), reason: z.string() });
const refundChecker = new Agent({
  name: "Refund checker",
  instructions: "Decide if the customer's refund request is eligible under a 30-day policy. Look up the order first.",
  model: "gpt-4.1",
  tools: [
    lookupOrder
  ],
  outputType: RefundCheckSchema,
  modelSettings: {
    temperature: 0.2,
    store: true
  }
});

const replyWriter = new Agent({
  name: "Reply writer",
  instructions: "Write a short, kind reply to the customer confirming that the refund was approved.",
  model: "gpt-4.1-mini",
  modelSettings: {
    store: true
  }
});

const approvalRequest = (message: string) => {

  // TODO: Implement
  return true;
}

type WorkflowInput = { input_as_text: string };


// Main code entrypoint
export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Refund approvals", async () => {
    const state = {

    };
    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] }
    ];
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_example_refunds"
      }
    });
    const refundCheckerResultTemp = await runner.run(
      refundChecker,
      [
        ...conversationHistory
      ]
    );
    conversationHistory.push(...refundCheckerResultTemp.newItems.map((item) => item.rawItem));

    if (!refundCheckerResultTemp.finalOutput) {
        throw new Error("Agent result is undefined");
    }

    const refundCheckerResult = {
      output_text: JSON.stringify(refundCheckerResultTemp.finalOutput),
      output_parsed: refundCheckerResultTemp.finalOutput
    };
    if (refundCheckerResult.output_parsed.eligible == true) {
      const approvalMessage = "Approve this refund?";

      if (approvalRequest(approvalMessage)) {
          const replyWriterResultTemp = await runner.run(
            replyWriter,
            [
              ...conversationHistory
            ]
          );
          conversationHistory.push(...replyWriterResultTemp.newItems.map((item) => item.rawItem));

          if (!replyWriterResultTemp.finalOutput) {
              throw new Error("Agent result is undefined");
          }

          const replyWriterResult = {
            output_text: replyWriterResultTemp.finalOutput ?? ""
          };
          return replyWriterResult;
      } else {
          return { message: "The refund was not approved." };
      }
    } else {
      return { message: refundCheckerResult.output_parsed.reason };
    }
  });
}
