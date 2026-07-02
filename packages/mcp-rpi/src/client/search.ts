/**
 * Unified file-system search helper for RPI.
 *
 * Every file-system-backed `list_*` tool (audiences, selection rules,
 * interactions, etc.) uses this to call `POST /client/file-system/search-file-infos`
 * with the right `fileTypeFilters` / `subTypeFilters`.
 *
 * Configuration items (e.g. audience definitions) do NOT use this helper —
 * their endpoints don't support search and require a fetch-all + client-side
 * filter pattern instead.
 */
import type { RPIApiClient, RequestOptions } from "./rpi-api.js";

/**
 * `$jsonTypeID` / `$jsonType` discriminators required by RPI's polymorphic
 * JSON deserializer. Verified against the generated OpenAPI spec.
 */
const SEARCH_REQUEST_JSON_TYPE_ID = "e55bff8b-a6ab-4e82-abb2-6d4b08f16917";
const SEARCH_REQUEST_JSON_TYPE = "SearchWithTypesPagingFilterJsonRequestMessage";

const SEARCH_FILE_INFOS_PATH = "/client/file-system/search-file-infos";

export type ResultsOrder =
  | "TypeAndName"
  | "FolderName"
  | "DateModified"
  | "DateCreated";

export type TemplateFilter = "NoFilter" | "TemplatesOnly" | "NonTemplatesOnly";

export interface SearchFileInfosOptions {
  /** File types to match (e.g. ["Audience"]). Empty or omitted = no type filter. */
  fileTypes?: string[];
  /** Sub-types within the file type (rarely used). */
  subTypes?: string[];
  /** Name filter. "*" matches all. Defaults to "*". */
  searchString?: string;
  /** 1-based page number. Defaults to 1. */
  pageNumber?: number;
  /** Page size, 5–255. Defaults to 10. */
  pageSize?: number;
  /** Folder to restrict the search to. */
  folderId?: string;
  /** Sort order. Defaults to `TypeAndName`. */
  resultsOrder?: ResultsOrder;
  /** Defaults to `NoFilter`. */
  templateFilter?: TemplateFilter;
}

export interface SearchFileInfosBody {
  pageNumber: number;
  pageSize: number;
  searchString: string;
  resultsOrder: ResultsOrder;
  templateFilter: TemplateFilter;
  fileTypeFilters?: string[];
  subTypeFilters?: string[];
  $jsonTypeID: string;
  $jsonType: string;
}

/**
 * Build the JSON body for a `search-file-infos` POST. Exported for tests and
 * for callers that want to inspect / tweak the body before sending.
 */
export function buildSearchFileInfosBody(
  options: SearchFileInfosOptions,
): SearchFileInfosBody {
  // RPI's "search by folder" trick: prefix the searchString with the folder id
  // segmenter. For MVP we just pass folderId through when provided; if we ever
  // need richer folder semantics we can mirror Java's `getSearchString` helper.
  const searchString = options.searchString ?? "*";

  const body: SearchFileInfosBody = {
    pageNumber: options.pageNumber ?? 1,
    pageSize: options.pageSize ?? 10,
    searchString,
    resultsOrder: options.resultsOrder ?? "TypeAndName",
    templateFilter: options.templateFilter ?? "NoFilter",
    $jsonTypeID: SEARCH_REQUEST_JSON_TYPE_ID,
    $jsonType: SEARCH_REQUEST_JSON_TYPE,
  };

  if (options.fileTypes && options.fileTypes.length > 0) {
    body.fileTypeFilters = options.fileTypes;
  }
  if (options.subTypes && options.subTypes.length > 0) {
    body.subTypeFilters = options.subTypes;
  }
  // folderId is currently not part of the RPI request model — callers that
  // need folder-scoped searches should construct a `searchCriteria` entry.
  // Recorded on the body as a no-op for now so callers can thread it through.
  if (options.folderId) {
    (body as SearchFileInfosBody & { folderId?: string }).folderId = options.folderId;
  }

  return body;
}

/**
 * Call `POST /client/file-system/search-file-infos` with the given options.
 */
export async function searchFileInfos<T = unknown>(
  rpiClient: RPIApiClient,
  userToken: string | undefined,
  options: SearchFileInfosOptions,
  requestOptions?: RequestOptions,
): Promise<T> {
  const body = buildSearchFileInfosBody(options);
  return rpiClient.post<T>(userToken, SEARCH_FILE_INFOS_PATH, body, requestOptions);
}

const FILE_INFO_PATH = "/client/file-system/file-info";

/**
 * Call `GET /client/file-system/file-info?ID=<id>` for a single file-system
 * object. Unlike `search-file-infos` (which returns empty folder-path fields),
 * this endpoint populates `fullPath` — the object's full path including its
 * ancestor folders. Shared by `get_file_info_by_id` and by the `get_*_by_name`
 * tools, which call it per match to enrich each result with its `fullPath`.
 */
export async function fetchFileInfo<T = unknown>(
  rpiClient: RPIApiClient,
  userToken: string | undefined,
  id: string,
  requestOptions?: RequestOptions,
): Promise<T> {
  return rpiClient.get<T>(userToken, FILE_INFO_PATH, { ID: id }, requestOptions);
}

/**
 * Enrich `search-file-infos` matches with their `fullPath`. That endpoint
 * leaves `fullPath` empty, so each match is resolved via a parallel
 * `file-info` lookup by id. Used by the `get_*_by_name` tools so callers get
 * the full folder path for disambiguation without a second round-trip.
 * Resilient: a match whose lookup fails (or that has no id) gets
 * `fullPath: null` rather than failing the whole call.
 */
export async function enrichMatchesWithFullPath<
  T extends { id?: string | null },
>(
  rpiClient: RPIApiClient,
  userToken: string | undefined,
  matches: T[],
  requestOptions?: RequestOptions,
): Promise<Array<T & { fullPath: string | null }>> {
  return Promise.all(
    matches.map(async (m) => {
      if (!m.id) return { ...m, fullPath: null };
      try {
        const info = await fetchFileInfo<{ fullPath?: string | null }>(
          rpiClient,
          userToken,
          m.id,
          requestOptions,
        );
        return { ...m, fullPath: info?.fullPath ?? null };
      } catch {
        return { ...m, fullPath: null };
      }
    }),
  );
}
