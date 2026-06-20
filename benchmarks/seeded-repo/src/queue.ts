import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

// FAILURE 1: Redis hostname mismatch
// The application tries to connect to a Redis host that is incorrectly spelled or pointing to an env value that is missing
const redisHost = process.env.REDIS_HOST_VAR_MISPELLED || "redis-invalid-hostname";
export const redisConnection = new Redis({
  host: redisHost,
  port: 6379,
  maxRetriesPerRequest: null
});

// FAILURE 2: BullMQ queue-name mismatch
// The producer pushes to 'interviews-queue', but the worker listens on 'interview-queue'
export const interviewQueue = new Queue("interviews-queue", { connection: redisConnection });

export async function addInterviewJob(interviewId: string) {
  await interviewQueue.add("process-interview", { interviewId });
}

// Worker listens on 'interview-queue' (mismatch: interview-queue vs interviews-queue)
export const interviewWorker = new Worker(
  "interview-queue",
  async (job) => {
    console.log(`Processing interview ${job.data.interviewId}`);
  },
  { connection: redisConnection }
);
