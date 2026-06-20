import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "talent-platform" });

// FAILURE 3: Inngest event-name mismatch
// Inngest function triggers on "interview.created"
export const processInterviewCreated = inngest.createFunction(
  { id: "process-interview-created" },
  { event: "interview.created" }, // triggers on interview.created
  async ({ event, step }) => {
    return { status: "processed", data: event.data };
  }
);

// Event emitter sends "interviews.created" (mismatch: interview.created vs interviews.created)
export async function sendInterviewCreatedEvent(interviewId: string) {
  await inngest.send({
    name: "interviews.created", // event name sent is interviews.created
    data: { interviewId }
  });
}
