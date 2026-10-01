import { createExpressServer } from "routing-controllers";
import { env } from "./env";

createExpressServer({
  routePrefix: env.app.routePrefix,
  controllers: env.app.dirs.controllers,
});
