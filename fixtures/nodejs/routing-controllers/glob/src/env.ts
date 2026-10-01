import path from "node:path";

export const env = {
  app: {
    routePrefix: process.env.API_ROUTE_PREFIX,
    dirs: { controllers: [path.join(__dirname, "api/controllers/**/*Controller{.js,.ts}")] },
  },
};
