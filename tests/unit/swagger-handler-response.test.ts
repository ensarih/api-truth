import {expect, test} from "vitest";
import {inspectBoundResponseStatus} from "../../analyzers/nodejs/src/handler-candidates.js";
const inspect = (text: string) => inspectBoundResponseStatus("controllers/orders.js", text, "getOrder");

test.each([
  'exports.getOrder = function(req, res) { return res.status(201).json({ok:true}); };',
  'module.exports = {getOrder}; function getOrder(req, res) { return res.sendStatus(201); }',
  'const getOrder = (req, reply) => reply.status(201).send("ok"); module.exports = {getOrder};',
  'module.exports = {getOrder(req, res) { return res.status(201).end(); }};'
])("extracts an exact response status declaration from the bound export: %s", text => {
  expect(inspect(text)).toMatchObject({kind: "declared", code: 201, line: 1, span: expect.stringMatching(/^span:/)});
});

test.each([
  'exports.getOrder = function(req, res) { if (req.ok) return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(req.status); };',
  'exports.getOrder = function(req, res) { res = fake; return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return other.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.status(201).json(res.status(500)); };',
  'exports.getOrder = function(req, res) { return res.status(201).json({...req.body}); };',
  'exports.getOrder = function(req, res) { return res.status(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(700); };',
  'exports.getOrder = function(req, res) { return res.status(201).json({[req.key]:true}); };',
  'exports.getOrder = function(req, res = other) { return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(201); }; exports.getOrder = other;',
  'exports.other = function(req, res) { return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.status(201).json(req.body); };'
])("keeps unsupported response flows unresolved: %s", text => {
  expect(inspect(text)).toEqual({kind: "unresolved"});
});
