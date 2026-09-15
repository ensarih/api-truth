import { Router } from "express";
import { requireApiToken } from "./security";
import { createOrder, getOrder, updateOrder } from "./orders-service";
import { validateOrder } from "./validation";

export const ordersRouter = Router();
ordersRouter.use(requireApiToken);

ordersRouter.get("/orders/:orderId", getOrder);
ordersRouter.post("/orders", validateOrder, createOrder);
ordersRouter.put("/orders/:orderId", validateOrder, updateOrder);

const legacySuffix = process.env.LEGACY_SUFFIX;
ordersRouter.get("/orders/legacy/" + legacySuffix, getOrder);
