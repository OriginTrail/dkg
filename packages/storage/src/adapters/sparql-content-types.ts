/**
 * Shared SPARQL 1.1 Protocol request Content-Type values, carrying an explicit
 * `charset=utf-8` parameter.
 *
 * `charset=utf-8` is REQUIRED for Jetty-backed stores (Blazegraph): a raw
 * request body whose Content-Type lacks a charset parameter is decoded as
 * ISO-8859-1 (the servlet-spec default), which mojibakes every non-ASCII
 * character in a query pattern / FILTER and in `INSERT DATA` / `DELETE DATA`
 * literals — corrupting writes and silently breaking deletes/matches. UTF-8 is
 * also what the SPARQL 1.1 Protocol prescribes. Centralized here so the two
 * HTTP adapters (blazegraph, sparql-http) share one source of truth and future
 * request paths can't drift back to a charset-less Content-Type.
 */
export const SPARQL_QUERY_CONTENT_TYPE = 'application/sparql-query; charset=utf-8';
export const SPARQL_UPDATE_CONTENT_TYPE = 'application/sparql-update; charset=utf-8';
