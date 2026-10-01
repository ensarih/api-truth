import { createExpressServer } from "routing-controllers";
import { OrdersController } from "./controller";

createExpressServer({ controllers: [OrdersController] });
