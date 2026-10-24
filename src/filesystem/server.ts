// The filesystem server, built per call by createServer(). index.ts is the
// stdio entry point that resolves the allowed directories from argv and hands
// them here. Building the server in a factory, rather than at module load,
// lets the tests drive a real Client against it in-process over an in-memory
// transport (#4854), and holding the allow-list in this closure rather than in
// a module global lets two instances coexist in one process.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RootsListChangedNotificationSchema,
  type Root,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { minimatch } from "minimatch";
import { getValidRootDirectories } from "./roots-utils.js";
import {
  formatSize,
  validatePath,
  getFileStats,
  searchFilesWithValidation,
  grepFilesContent,
  clearValidatedPathCache,
  getFileLineEndingsText,
  convertFileLineEndingsText,
} from "./lib.js";
import { SERVER_VERSION } from "./version.js";

// The JSON Schema dialect every advertised tool schema declares (#4841). The
// SDK 1.x tools/list handler renders zod schemas with zod's draft-07 target and
// stamps "$schema": draft-07 on each one, which validators that accept only
// 2020-12 (the dialect MCP assumes for tool schemas) reject outright. Setting
// $schema in the root object's zod metadata overrides that stamp. The schemas
// below use nothing whose draft-07 and 2020-12 renderings differ (no tuples),
// so the label is the only change; server-tools.test.ts fails if a draft-07-only
// keyword ever appears under it.
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** A tool's input or output shape as an object schema declaring 2020-12. */
function jsonSchema2020<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).meta({ $schema: JSON_SCHEMA_DIALECT });
}

// Schema definitions
const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z
    .enum(["name", "size"])
    .optional()
    .default("name")
    .describe("Sort entries by name or size"),
  format: z
    .enum(["compact", "padded"])
    .optional()
    .default("compact")
    .describe("Output format: compact space-saving or padded tabular"),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe("Maximum directory depth to traverse"),
  excludePatterns: z.array(z.string()).optional().default([]),
  format: z
    .enum(["indented", "json"])
    .optional()
    .default("indented")
    .describe("Output format: compact indented outline or json"),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
  relativePaths: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to return paths relative to search root directory"),
});

const GrepSearchArgsSchema = z.object({
  path: z.string().describe("Starting directory or file path to search"),
  pattern: z.string().describe("Regular expression or string pattern to search for in file contents"),
  isRegex: z.boolean().optional().default(true).describe("Whether pattern should be evaluated as a regex (true) or literal substring (false)"),
  caseSensitive: z.boolean().optional().default(true).describe("Whether the match should be case sensitive"),
  maxMatches: z.number().optional().default(100).describe("Maximum number of matching lines to return"),
  includeGlobs: z.array(z.string()).optional().default([]).describe("Optional glob patterns of files to include"),
  excludePatterns: z.array(z.string()).optional().default([]).describe("Optional patterns of directories/files to exclude"),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const GetFileLineEndingsArgsSchema = z.object({
  path: z.string().describe("Path to the file or directory to check"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to check subdirectories recursively if path is a directory"),
});

const ConvertLineEndingsArgsSchema = z.object({
  path: z.string().describe("Path to the file or directory to convert"),
  target: z
    .enum(["lf", "crlf"])
    .describe("Target line ending format ('lf' or 'crlf')"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to convert files in subdirectories recursively if path is a directory"),
});

/**
 * Why the server cannot operate when it has no allowed directories from either
 * the command line or the client's Roots (#4992).
 */
export const NO_ALLOWED_DIRECTORIES_ERROR =
  "Server cannot operate: No allowed directories available. Server was started without command-line directories and client does not support MCP roots protocol. Please either: 1) Start server with directory arguments, or 2) Use a client that supports MCP roots protocol and provides valid root directories.";

export interface ServerOptions {
  /**
   * Called after the server has closed the connection because it cannot
   * operate: no directories were given and the client does not support
   * Roots (#4992). The stdio entry point exits the process from here.
   */
  onCannotOperate?: (error: Error) => void;
}

/**
 * Build a filesystem server that may touch only `initialAllowedDirectories`
 * (already resolved and normalized by the caller) until the client's Roots
 * replace them.
 */
export function createServer(
  initialAllowedDirectories: string[],
  options: ServerOptions = {},
): McpServer {
  let allowedDirectories = [...initialAllowedDirectories];
  // True once the client's roots have replaced the command-line directories.
  // From then on a roots update replaces them even with none, so a client that
  // withdraws its roots withdraws the server's access too (#5094). Until then an
  // update with no valid roots keeps the command-line directories.
  let rootsInForce = false;
  // Each roots refresh (the initial load and every roots/list_changed) takes
  // the next generation before it asks for roots. The SDK runs notification
  // handlers without waiting for earlier ones, so answers can come back out of
  // order; one is applied only if no newer refresh has started since, so a
  // stale answer cannot undo a newer update, such as a revocation (#5097).
  let rootsGeneration = 0;

  const server = new McpServer({
    name: "secure-filesystem-server",
    version: SERVER_VERSION,
  });

  // The barrier every tool call waits on, so a call that arrives while roots are
  // being fetched is checked against the roots that come back rather than the
  // ones being replaced: the command-line directories while the initial
  // roots/list is outstanding (#3204), or a root the client has just withdrawn
  // while a roots/list_changed refresh is pending (#5101). Each refresh (the
  // initial load included) installs a new barrier before it sends roots/list,
  // and settles it when it finishes, successfully or not. Installing one also
  // settles the barrier it replaces, so calls waiting on an older refresh wake
  // at once and move on to the newer one instead of waiting for the older
  // one's answer (#5097, #5101).
  let barrier = { settled: Promise.resolve(), settle: () => {} };
  function installBarrier(): () => void {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const replaced = barrier;
    barrier = { settled, settle };
    replaced.settle();
    return settle;
  }
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: Parameters<typeof registerTool>[1],
    handler: (...args: unknown[]) => unknown,
  ) =>
    registerTool(name, config, (async (...args: unknown[]) => {
      let awaited: typeof barrier;
      do {
        awaited = barrier;
        await awaited.settled;
      } while (awaited !== barrier);
      return handler(...args);
    }) as never)) as typeof server.registerTool;

  // Tool registrations

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in path with [F] and [D] prefixes.",
      inputSchema: jsonSchema2020(ListDirectoryArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const formatted = entries
        .map(
          (entry) =>
            `${entry.isDirectory() ? "[D]" : "[F]"} ${entry.name}`,
        )
        .join("\n");
      return {
        content: [{ type: "text" as const, text: formatted }],
        structuredContent: { content: formatted },
      };
    },
  );

  server.registerTool(
    "list_directory_with_sizes",
    {
      title: "List Directory with Sizes",
      description: "List directory entries with file sizes sorted by name or size.",
      inputSchema: jsonSchema2020(ListDirectoryWithSizesArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const entries = await fs.readdir(validPath, { withFileTypes: true });

      // Get detailed information for each entry in batches to avoid threadpool congestion
      const detailedEntries: Array<{
        name: string;
        isDirectory: boolean;
        size: number;
        mtime: Date;
      }> = [];

      const BATCH_SIZE = 128;
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            const entryPath = path.join(validPath, entry.name);
            try {
              const stats = await fs.stat(entryPath);
              return {
                name: entry.name,
                isDirectory: entry.isDirectory(),
                size: stats.size,
                mtime: stats.mtime,
              };
            } catch {
              return {
                name: entry.name,
                isDirectory: entry.isDirectory(),
                size: 0,
                mtime: new Date(0),
              };
            }
          }),
        );
        detailedEntries.push(...batchResults);
      }

      // Sort entries based on sortBy parameter
      const sortedEntries = [...detailedEntries].sort((a, b) => {
        if (args.sortBy === "size") {
          return b.size - a.size;
        }
        return a.name.localeCompare(b.name);
      });

      // Format the output
      const isPadded = args.format === "padded";
      const formattedEntries = sortedEntries.map(
        (entry) =>
          isPadded
            ? `${entry.isDirectory ? "[D]" : "[F]"} ${entry.name.padEnd(30)} ${
                entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
              }`
            : `${entry.isDirectory ? "[D]" : "[F]"} ${entry.name} ${
                entry.isDirectory ? "" : formatSize(entry.size)
              }`,
      );

      // Add summary
      const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
      const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
      const totalSize = detailedEntries.reduce(
        (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
        0,
      );

      const summary = [
        "",
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`,
      ];

      const text = [...formattedEntries, ...summary].join("\n");
      const contentBlock = { type: "text" as const, text };
      return {
        content: [contentBlock],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "directory_tree",
    {
      title: "Directory Tree",
      description: "Recursive directory tree in compact indented text or JSON structure.",
      inputSchema: jsonSchema2020(DirectoryTreeArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
      interface TreeEntry {
        name: string;
        type: "file" | "directory";
        children?: TreeEntry[];
      }
      const rootPath = args.path;

      // Precompile exclude patterns into RegExp instances
      const excludeRes: RegExp[] = [];
      for (const pattern of args.excludePatterns) {
        if (pattern.includes("*")) {
          const re = minimatch.makeRe(pattern, { dot: true });
          if (re) excludeRes.push(re);
        } else {
          const r1 = minimatch.makeRe(pattern, { dot: true });
          const r2 = minimatch.makeRe(`**/${pattern}`, { dot: true });
          const r3 = minimatch.makeRe(`**/${pattern}/**`, { dot: true });
          if (r1) excludeRes.push(r1);
          if (r2) excludeRes.push(r2);
          if (r3) excludeRes.push(r3);
        }
      }

      async function buildTree(
        currentPath: string,
        currentDepth: number,
      ): Promise<TreeEntry[]> {
        const validPath = await validatePath(currentPath, allowedDirectories);
        const entries = await fs.readdir(validPath, { withFileTypes: true });

        const filteredEntries: Array<{ name: string; isDir: boolean }> = [];
        for (const entry of entries) {
          const rawRelative = path.relative(
            rootPath,
            path.join(currentPath, entry.name),
          );
          const relativePath =
            path.sep === "\\"
              ? rawRelative.replace(/\\/g, "/")
              : rawRelative;

          const shouldExclude = excludeRes.some((re) => re.test(relativePath));
          if (shouldExclude) continue;

          filteredEntries.push({
            name: entry.name,
            isDir: entry.isDirectory(),
          });
        }

        const childPromises = filteredEntries.map(async (entry) => {
          const entryData: TreeEntry = {
            name: entry.name,
            type: entry.isDir ? "directory" : "file",
          };

          if (entry.isDir) {
            if (currentDepth < args.maxDepth) {
              const subPath = path.join(currentPath, entry.name);
              entryData.children = await buildTree(subPath, currentDepth + 1);
            } else {
              entryData.children = [];
            }
          }

          return entryData;
        });

        return await Promise.all(childPromises);
      }

      function formatIndentedTree(entries: TreeEntry[], indent = ""): string {
        const lines: string[] = [];
        for (const entry of entries) {
          if (entry.type === "directory") {
            lines.push(`${indent}${entry.name}/`);
            if (entry.children && entry.children.length > 0) {
              lines.push(formatIndentedTree(entry.children, `${indent}  `));
            }
          } else {
            lines.push(`${indent}${entry.name}`);
          }
        }
        return lines.join("\n");
      }

      const treeData = await buildTree(rootPath, 1);
      const text =
        args.format === "json"
          ? JSON.stringify(treeData, null, 2)
          : formatIndentedTree(treeData);
      const contentBlock = { type: "text" as const, text };
      return {
        content: [contentBlock],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description: "Search directory recursively for files matching glob pattern.",
      inputSchema: jsonSchema2020(SearchFilesArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof SearchFilesArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const results = await searchFilesWithValidation(
        validPath,
        args.pattern,
        allowedDirectories,
        { excludePatterns: args.excludePatterns },
      );
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matches found" }],
          structuredContent: { content: "No matches found" },
        };
      }
      let text: string;
      if (args.relativePaths) {
        const relativeMatches = results.map((p) => {
          const rel = path.relative(validPath, p);
          return path.sep === "\\" ? rel.replace(/\\/g, "/") : rel;
        });
        text = `Base: ${validPath}\n${relativeMatches.join("\n")}`;
      } else {
        text = results.join("\n");
      }
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "get_file_info",
    {
      title: "Get File Info",
      description: "Get size, timestamps, type, and permissions for a path.",
      inputSchema: jsonSchema2020(GetFileInfoArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const info = await getFileStats(validPath);
      const text = Object.entries(info)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "grep_search",
    {
      title: "Grep Search",
      description: "Search file contents recursively using regex or string pattern.",
      inputSchema: jsonSchema2020(GrepSearchArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof GrepSearchArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const matches = await grepFilesContent(
        validPath,
        args.pattern,
        allowedDirectories,
        {
          isRegex: args.isRegex,
          caseSensitive: args.caseSensitive,
          maxMatches: args.maxMatches,
          includeGlobs: args.includeGlobs,
          excludePatterns: args.excludePatterns,
        },
      );

      const text =
        matches.length > 0
          ? `Base: ${validPath}\n` +
            matches
              .map((m) => {
                const rawRel = path.relative(validPath, m.filePath);
                const rel =
                  (path.sep === "\\" ? rawRel.replace(/\\/g, "/") : rawRel) ||
                  path.basename(m.filePath);
                return `${rel}:${m.lineNumber}: ${m.lineContent}`;
              })
              .join("\n")
          : "No matches found";

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "list_allowed_directories",
    {
      title: "List Allowed Directories",
      description: "List directories the server is allowed to access.",
      inputSchema: jsonSchema2020({}),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const text = `Allowed directories:\n${allowedDirectories.join("\n")}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "get_file_line_endings",
    {
      title: "Get File Line Endings",
      description:
        "Check line ending format (CRLF, LF, mixed, or none) of a file or directory.",
      inputSchema: jsonSchema2020(GetFileLineEndingsArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof GetFileLineEndingsArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const text = await getFileLineEndingsText(validPath, allowedDirectories, {
        recursive: args.recursive,
      });
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  server.registerTool(
    "convert_line_endings",
    {
      title: "Convert Line Endings",
      description:
        "Convert line endings of a file or directory to LF or CRLF without modifying binary files.",
      inputSchema: jsonSchema2020(ConvertLineEndingsArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args: z.infer<typeof ConvertLineEndingsArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const text = await convertFileLineEndingsText(
        validPath,
        args.target,
        allowedDirectories,
        { recursive: args.recursive },
      );
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  // Updates allowed directories based on MCP client roots, unless a newer
  // refresh started after this one's `generation` was taken (#5097).
  async function updateAllowedDirectoriesFromRoots(
    requestedRoots: Root[],
    generation: number,
  ) {
    clearValidatedPathCache();
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (generation !== rootsGeneration) {
      console.error(
        "Discarded a stale roots/list answer: a newer roots update has started",
      );
      return;
    }
    if (validatedRootDirs.length > 0) {
      allowedDirectories = [...validatedRootDirs];
      rootsInForce = true;
      console.error(
        `Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`,
      );
    } else if (rootsInForce) {
      allowedDirectories = [];
      console.error(
        "No valid root directories provided by client; access revoked until it exposes a root again",
      );
    } else {
      console.error("No valid root directories provided by client");
    }
  }

  // Handles dynamic roots updates during runtime, when client sends "roots/list_changed" notification, server fetches the updated roots and replaces all allowed directories with the new roots.
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      const generation = ++rootsGeneration;
      const settle = installBarrier();
      try {
        // Request the updated roots list from the client
        const response = await server.server.listRoots();
        /* v8 ignore else -- the SDK validates the roots/list result against ListRootsResultSchema, which requires roots, so the implicit else cannot run */
        if (response && "roots" in response) {
          await updateAllowedDirectoriesFromRoots(response.roots, generation);
        }
      } catch (error) {
        console.error(
          "Failed to request roots from client:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        settle();
      }
    },
  );

  // Handles post-initialization setup, specifically checking for and fetching
  // MCP roots. The initial load claims its generation and installs its barrier
  // here, synchronously, before any roots/list_changed handled afterwards can
  // claim a newer one.
  server.server.oninitialized = () => {
    const generation = ++rootsGeneration;
    const settle = installBarrier();
    // Not awaited: oninitialized is synchronous. Tool calls wait on the
    // barrier, which settles when initialize() finishes; it never rejects.
    void initialize(generation).finally(settle);
  };

  async function initialize(generation: number): Promise<void> {
    const clientCapabilities = server.server.getClientCapabilities();

    if (clientCapabilities?.roots) {
      try {
        const response = await server.server.listRoots();
        /* v8 ignore else -- the SDK validates the roots/list result against ListRootsResultSchema, which requires roots, so the else cannot run */
        if (response && "roots" in response) {
          await updateAllowedDirectoriesFromRoots(response.roots, generation);
        } else {
          console.error(
            "Client returned no roots set, keeping current settings",
          );
        }
      } catch (error) {
        console.error(
          "Failed to request initial roots from client:",
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      if (allowedDirectories.length > 0) {
        console.error(
          "Client does not support MCP Roots, using allowed directories set from server args:",
          allowedDirectories,
        );
      } else {
        // Nothing could ever be allowed in this session, so fail visibly
        // rather than serve every call with "Access denied" (#4992): log the
        // reason and close the connection. Throwing here would only reach the
        // SDK's onerror, which the client never sees.
        const error = new Error(NO_ALLOWED_DIRECTORIES_ERROR);
        console.error(`Error: ${error.message}`);
        await server.close();
        options.onCannotOperate?.(error);
      }
    }
  }

  return server;
}
