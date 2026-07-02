import { Hono } from "hono";
import { listProviders } from "../config/providers.js";

export const providerRoutes = new Hono();

providerRoutes.get("/", (c) => {
  return c.json(listProviders());
});
