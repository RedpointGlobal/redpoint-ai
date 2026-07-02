/**
 * Type helpers for the RPI Integration API.
 *
 * Primary usage: import schema types directly for typing API responses.
 *   import type { components } from "../client/rpi-types.js";
 *   type MyResponse = components["schemas"]["SomeJsonResponseMessage"];
 *
 * Path-level helpers (GetResponse, PostResponse, etc.) are available for
 * endpoints where tool paths align with OpenAPI spec paths.
 */
import type { paths, components, operations } from "./rpi-api.generated.js";

/** Extract the JSON body from a response object */
type JsonBody<T> = T extends { content: { "application/json": infer R } }
  ? R
  : unknown;

/** Extract the success response type (200 or 201) for a given operation */
type SuccessResponse<T> = T extends { responses: infer R }
  ? R extends { 200: infer S }
    ? JsonBody<S>
    : R extends { 201: infer S }
      ? JsonBody<S>
      : unknown
  : unknown;

/** GET response type for an OpenAPI path */
export type GetResponse<P extends keyof paths> = "get" extends keyof paths[P]
  ? SuccessResponse<paths[P]["get"]>
  : never;

/** POST response type for an OpenAPI path */
export type PostResponse<P extends keyof paths> = "post" extends keyof paths[P]
  ? SuccessResponse<paths[P]["post"]>
  : never;

/** PUT response type for an OpenAPI path */
export type PutResponse<P extends keyof paths> = "put" extends keyof paths[P]
  ? SuccessResponse<paths[P]["put"]>
  : never;

/** POST request body type for an OpenAPI path */
export type PostBody<P extends keyof paths> = "post" extends keyof paths[P]
  ? paths[P]["post"] extends {
      requestBody: { content: { "application/json": infer B } };
    }
    ? B
    : unknown
  : never;

/** PUT request body type for an OpenAPI path */
export type PutBody<P extends keyof paths> = "put" extends keyof paths[P]
  ? paths[P]["put"] extends {
      requestBody: { content: { "application/json": infer B } };
    }
    ? B
    : unknown
  : never;

export type { paths, components, operations };