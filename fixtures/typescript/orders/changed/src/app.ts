import express from "express";
import { ordersRouter } from "./orders-routes";

export const app = express();
app.use(express.json());
app.use("/api", ordersRouter);
