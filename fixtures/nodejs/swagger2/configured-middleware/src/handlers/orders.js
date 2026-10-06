"use strict";

module.exports = { getOrder };

function getOrder(req, res) {
  res.json({ id: req.swagger.params.id.value });
}
