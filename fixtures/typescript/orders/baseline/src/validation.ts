import type { RequestHandler } from "express";

export const validateOrder: RequestHandler = (request, response, next) => {
  const body = request.body;
  if (!body?.customer?.id || !body.customer?.address?.city || !Array.isArray(body.items)) {
    response.status(400).json({ error: "invalid order" });
    return;
  }
  if (body.priority !== undefined && !["standard", "expedited"].includes(body.priority)) {
    response.status(400).json({ error: "invalid priority" });
    return;
  }
  next();
};
