const express = require("express");
const SwaggerExpress = require("swagger-express-mw");
const app = express();

SwaggerExpress.create({ appRoot: __dirname }, function (error, middleware) {
  if (error) throw error;
  middleware.register(app);
});
