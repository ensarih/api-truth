import type { RequestHandler } from "express";

export const requireApiToken: RequestHandler = (_request, _response, next) => next();
