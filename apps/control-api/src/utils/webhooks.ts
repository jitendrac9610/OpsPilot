import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export async function triggerWebhook(orgId: string, event: string, payload: any) {
  try {
    const integrations = await prisma.integration.findMany({
      where: { orgId, provider: "webhook" }
    });

    for (const integration of integrations) {
      const config = integration.config as { url?: string; secret?: string };
      if (config.url) {
        logger.info({ url: config.url, event }, "Dispatching outbound webhook event");
        fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opspilot-event": event
          },
          body: JSON.stringify({
            event,
            payload,
            timestamp: new Date().toISOString()
          })
        }).catch(err => logger.error({ err, url: config.url }, "Failed to deliver webhook payload"));
      }
    }
  } catch (err) {
    logger.error({ err }, "Error checking webhook integrations");
  }
}
