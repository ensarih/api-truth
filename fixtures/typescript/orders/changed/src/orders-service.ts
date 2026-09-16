import type { Request, Response } from "express";
import type { CreateOrderBody, OrderView } from "./types";

export async function getOrder(request: Request, response: Response) {
  const includeItems = request.query.includeItems;
  const body: OrderView = { id: request.params.orderId, state: "confirmed" };
  response.type("application/json").status(200).json({ ...body, includeItems });
}

export async function createOrder(request: Request<{}, OrderView, CreateOrderBody>, response: Response) {
  response.type("application/json").status(201).json({ id: "ord-101", state: "pending" });
}

export async function updateOrder(request: Request<{ orderId: string }, OrderView, CreateOrderBody>, response: Response) {
  response.type("application/json").status(200).json({ id: request.params.orderId, state: "pending" });
}

export async function cancelOrder(request: Request<{ orderId: string }>, response: Response<OrderView>) {
  response.type("application/json").status(202).json({ id: request.params.orderId, state: "cancelling" });
}
