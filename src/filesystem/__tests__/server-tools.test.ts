// Characterization suite for every filesystem tool, driven through an SDK
// Client over an in-memory transport (#4854). It pins what the server does
// today on SDK 1.x, quirks included, so the SDK v2 migration (#4856) can prove
// it changed nothing on the wire. A test that pins a known bug says so, with
// the issue number, so the fix has a test to change.

import fs from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  allowedDirectoriesOf,
  call,
  connect,
  makeTempDir,
  quietStderr,
  textOf,
  type Connected,
} from "./helpers.js";

const canSymlink = await (async () => {
  try {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-probe-"));
    const target = path.join(testDir, "target");
    const link = path.join(testDir, "link");
    await fs.writeFile(target, "x");
    await fs.symlink(target, link);
    await fs.rm(testDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const packageJson = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const TOOL_NAMES = [
  "list_directory",
  "list_directory_with_sizes",
  "directory_tree",
  "search_files",
  "get_file_info",
  "grep_search",
  "list_allowed_directories",
];

interface TreeEntry {
  name: string;
  type: "file" | "directory";
  children?: TreeEntry[];
}

/** Sort a directory_tree result by name at every level; readdir order is the OS's. */
function sortTree(entries: TreeEntry[]): TreeEntry[] {
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      entry.children ? { ...entry, children: sortTree(entry.children) } : entry,
    );
}

let dir: string;
let conn: Connected;
let client: Client;

beforeEach(async () => {
  // The server logs its roots decision to stderr on every connect.
  quietStderr();
  dir = await makeTempDir("mcp-fs-tools-");
  conn = await connect([dir]);
  client = conn.client;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("server identity and tool list", () => {
  it("reports its name and the package.json version (#360, fixed by #4472)", () => {
    expect(client.getServerVersion()).toEqual({
      name: "secure-filesystem-server",
      version: packageJson.version,
    });
  });

  it("advertises only the tools capability", () => {
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
    });
  });

  it("lists the 7 tools in registration order", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  // #3402: the read-only tools carry no idempotentHint or destructiveHint.
  // When that issue is fixed, this table is the test to change.
  it("pins each tool's title and annotations (#3402)", async () => {
    const { tools } = await client.listTools();
    const table = Object.fromEntries(
      tools.map((t) => [t.name, { title: t.title, ...t.annotations }]),
    );
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    expect(table).toEqual({
      list_directory: { title: "List Directory", ...readOnly },
      list_directory_with_sizes: {
        title: "List Directory with Sizes",
        ...readOnly,
      },
      directory_tree: { title: "Directory Tree", ...readOnly },
      search_files: { title: "Search Files", ...readOnly },
      get_file_info: { title: "Get File Info", ...readOnly },
      grep_search: { title: "Grep Search", ...readOnly },
      list_allowed_directories: {
        title: "List Allowed Directories",
        ...readOnly,
      },
    });
  });

  // #4841: the SDK 1.x tools/list handler stamps draft-07 on every schema it
  // renders, which validators that accept only JSON Schema 2020-12 reject. The
  // server declares 2020-12 instead.
  it("declares the 2020-12 $schema on every input and output schema (#4841)", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOL_NAMES.length);
    for (const tool of tools) {
      expect(tool.inputSchema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(tool.outputSchema?.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  // #4841: the schemas are still rendered with zod's draft-07 rules, so the
  // 2020-12 label holds only while they use no keyword whose meaning differs
  // between the two dialects: array-form (tuple) items, additionalItems, and
  // definitions rather than $defs.
  it("advertises no draft-07-only keyword under the 2020-12 label (#4841)", async () => {
    const { tools } = await client.listTools();
    const draft07Only: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${at}[${i}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (
          (key === "items" && Array.isArray(value)) ||
          key === "additionalItems" ||
          key === "definitions"
        ) {
          draft07Only.push(`${at}.${key}`);
        }
        walk(value, `${at}.${key}`);
      }
    };
    for (const tool of tools) {
      walk(tool.inputSchema, `${tool.name}.inputSchema`);
      walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }
    expect(draft07Only).toEqual([]);
  });

  it("pins the input schemas a client is shown", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const strip = (schema: Record<string, unknown>) => {
      const { $schema: _dialect, ...rest } = schema;
      return rest;
    };
    expect(strip(byName.list_directory.inputSchema)).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    });
    expect(strip(byName.list_allowed_directories.inputSchema)).toEqual({
      type: "object",
      properties: {},
    });
    expect(strip(byName.search_files.outputSchema!)).toEqual({
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    });
  });

  it("returns every tool's structuredContent as { content: string } mirroring the text block (#3110, #3106, #3093)", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "alpha");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_directory", { path: dir }],
      ["list_directory_with_sizes", { path: dir }],
      ["directory_tree", { path: dir }],
      ["search_files", { path: dir, pattern: "*.txt" }],
      ["get_file_info", { path: path.join(dir, "a.txt") }],
      ["grep_search", { path: dir, pattern: "alpha" }],
      ["list_allowed_directories", {}],
    ];
    for (const [name, args] of calls) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBeFalsy();
      expect(result.structuredContent, name).toEqual({
        content: textOf(result),
      });
    }
  });

  it("reports an unknown tool as a tool error", async () => {
    const result = await call(client, "no_such_tool");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "MCP error -32602: Tool no_such_tool not found",
    );
  });

  it("reports schema-invalid arguments as a tool error", async () => {
    const result = await call(client, "list_directory", { path: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^MCP error -32602: Input validation error: Invalid arguments for tool list_directory/,
    );
  });
});

describe("list_directory", () => {
  it("lists entries with [D] and [F] prefixes", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "f.txt"), "");
    const result = await call(client, "list_directory", { path: dir });
    expect(textOf(result).split("\n").sort()).toEqual([
      "[D] sub",
      "[F] f.txt",
    ]);
  });

  it("returns empty text for an empty directory", async () => {
    const result = await call(client, "list_directory", { path: dir });
    expect(textOf(result)).toBe("");
  });

  it("reports a file path as ENOTDIR", async () => {
    await fs.writeFile(path.join(dir, "f.txt"), "");
    const result = await call(client, "list_directory", {
      path: path.join(dir, "f.txt"),
    });
    expect(textOf(result)).toMatch(/^ENOTDIR/);
  });
});

describe("list_directory_with_sizes", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(dir, "b.txt"), "x".repeat(2048));
    await fs.writeFile(path.join(dir, "a.txt"), "xy");
    await fs.mkdir(path.join(dir, "c"));
  });

  it("sorts by name by default and appends a summary", async () => {
    const result = await call(client, "list_directory_with_sizes", {
      path: dir,
      format: "padded",
    });
    expect(textOf(result)).toBe(
      [
        `[F] ${"a.txt".padEnd(30)} ${"2 B".padStart(10)}`,
        `[F] ${"b.txt".padEnd(30)} ${"2.00 KB".padStart(10)}`,
        `[D] ${"c".padEnd(30)} `,
        "",
        "Total: 2 files, 1 directories",
        "Combined size: 2.00 KB",
      ].join("\n"),
    );
  });

  it("formats with compact spacing by default", async () => {
    const result = await call(client, "list_directory_with_sizes", {
      path: dir,
    });
    expect(textOf(result)).toContain("[F] a.txt 2 B");
    expect(textOf(result)).toContain("[F] b.txt 2.00 KB");
    expect(textOf(result)).toContain("[D] c");
  });

  it("sorts by size, largest first, when asked", async () => {
    const result = await call(client, "list_directory_with_sizes", {
      path: dir,
      sortBy: "size",
    });
    // Directories sort by their own stat size, which the listing does not
    // show and which varies by file system, so only the files are compared.
    const files = textOf(result)
      .split("\n")
      .filter((line) => line.startsWith("[F]"))
      .map((line) => line.split(/\s+/)[1]);
    expect(files).toEqual(["b.txt", "a.txt"]);
  });

  it.skipIf(!canSymlink)(
    "lists an entry it cannot stat (a dangling symlink) as size 0",
    async () => {
    await fs.symlink(path.join(dir, "gone"), path.join(dir, "dangling"));
    const result = await call(client, "list_directory_with_sizes", {
      path: dir,
      format: "padded",
    });
    expect(textOf(result)).toContain(
      `[F] ${"dangling".padEnd(30)} ${"0 B".padStart(10)}`,
    );
    expect(textOf(result)).toContain("Total: 3 files, 1 directories");
  });

  it("summarizes an empty directory", async () => {
    const empty = path.join(dir, "c");
    const result = await call(client, "list_directory_with_sizes", {
      path: empty,
    });
    expect(textOf(result)).toBe(
      "\nTotal: 0 files, 0 directories\nCombined size: 0 B",
    );
  });
});

describe("directory_tree", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, "src"));
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.mkdir(path.join(dir, ".git"));
    await fs.mkdir(path.join(dir, "nested", "node_modules"), {
      recursive: true,
    });
    await fs.writeFile(path.join(dir, ".env"), "");
    await fs.writeFile(path.join(dir, ".env.local"), "");
    await fs.writeFile(path.join(dir, "src", "index.js"), "");
    await fs.writeFile(path.join(dir, "package.json"), "{}");
    await fs.writeFile(path.join(dir, "node_modules", "m.js"), "");
    await fs.writeFile(path.join(dir, "nested", "node_modules", "d.js"), "");
  });

  async function tree(
    excludePatterns?: string[],
    root: string = dir,
    format: "json" | "indented" = "json",
  ): Promise<TreeEntry[]> {
    const result = await call(client, "directory_tree", {
      path: root,
      format,
      ...(excludePatterns ? { excludePatterns } : {}),
    });
    return sortTree(JSON.parse(textOf(result)) as TreeEntry[]);
  }

  it("returns compact indented outline by default", async () => {
    const result = await call(client, "directory_tree", {
      path: path.join(dir, "src"),
    });
    expect(textOf(result)).toBe("index.js");
  });

  it("returns the whole tree as 2-space-indented JSON; directories always carry children", async () => {
    const result = await call(client, "directory_tree", {
      path: path.join(dir, "src"),
      format: "json",
    });
    expect(textOf(result)).toBe(
      '[\n  {\n    "name": "index.js",\n    "type": "file"\n  }\n]',
    );
    expect(await tree()).toEqual([
      { name: ".env", type: "file" },
      { name: ".env.local", type: "file" },
      { name: ".git", type: "directory", children: [] },
      {
        name: "nested",
        type: "directory",
        children: [
          {
            name: "node_modules",
            type: "directory",
            children: [{ name: "d.js", type: "file" }],
          },
        ],
      },
      {
        name: "node_modules",
        type: "directory",
        children: [{ name: "m.js", type: "file" }],
      },
      { name: "package.json", type: "file" },
      {
        name: "src",
        type: "directory",
        children: [{ name: "index.js", type: "file" }],
      },
    ]);
  });

  it("excludes a bare name at any depth, and not its prefix matches", async () => {
    const names = (await tree(["node_modules", ".env"])).map((e) => e.name);
    expect(names).toEqual([
      ".env.local",
      ".git",
      "nested",
      "package.json",
      "src",
    ]);
    const nested = (await tree(["node_modules"])).find(
      (e) => e.name === "nested",
    );
    expect(nested?.children).toEqual([]);
  });

  it("matches a glob pattern against the relative path only", async () => {
    const names = (await tree(["*.env"])).map((e) => e.name);
    expect(names).not.toContain(".env");
    expect(names).toContain(".env.local");
    const deep = await tree(["*.js"]);
    // "*.js" does not cross a separator, so nested files stay.
    expect(deep.find((e) => e.name === "src")?.children).toEqual([
      { name: "index.js", type: "file" },
    ]);
  });

  it.skipIf(!canSymlink)(
    "lists a symlinked directory as a file and does not descend into it",
    async () => {
    await fs.symlink(path.join(dir, "src"), path.join(dir, "srclink"));
    const entry = (await tree()).find((e) => e.name === "srclink");
    expect(entry).toEqual({ name: "srclink", type: "file" });
  });

  it("refuses a root outside the allowed directories", async () => {
    const result = await call(client, "directory_tree", { path: "/" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Access denied/);
  });
});

describe("search_files", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, "sub", "deeper"), { recursive: true });
    await fs.writeFile(path.join(dir, "top.txt"), "");
    await fs.writeFile(path.join(dir, "top.log"), "");
    await fs.writeFile(path.join(dir, "sub", "mid.txt"), "");
    await fs.writeFile(path.join(dir, "sub", "deeper", "low.txt"), "");
  });

  async function search(args: Record<string, unknown>): Promise<string[]> {
    const text = textOf(
      await call(client, "search_files", {
        path: dir,
        relativePaths: false,
        ...args,
      }),
    );
    return text.split("\n").sort();
  }

  it("returns base directory and relative paths by default", async () => {
    const text = textOf(
      await call(client, "search_files", { path: dir, pattern: "*.txt" }),
    );
    expect(text).toBe(`Base: ${dir}\ntop.txt`);
  });

  it("matches a bare glob against top-level entries only", async () => {
    expect(await search({ pattern: "*.txt" })).toEqual([
      path.join(dir, "top.txt"),
    ]);
  });

  it("recurses into subdirectories for a ** glob", async () => {
    expect(await search({ pattern: "**/*.txt" })).toEqual([
      path.join(dir, "sub", "deeper", "low.txt"),
      path.join(dir, "sub", "mid.txt"),
      path.join(dir, "top.txt"),
    ]);
  });

  it("matches directories as well as files", async () => {
    expect(await search({ pattern: "**/deeper" })).toEqual([
      path.join(dir, "sub", "deeper"),
    ]);
  });

  it("skips excluded paths and does not descend into them", async () => {
    expect(
      await search({ pattern: "**/*.txt", excludePatterns: ["sub"] }),
    ).toEqual([path.join(dir, "top.txt")]);
  });

  it('says "No matches found" when nothing matches', async () => {
    const result = await call(client, "search_files", {
      path: dir,
      pattern: "*.none",
    });
    expect(textOf(result)).toBe("No matches found");
  });

  it.skipIf(!canSymlink)(
    "silently skips a symlink that leaves the allowed directories",
    async () => {
    const outside = await makeTempDir("mcp-fs-outside-");
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "");
      await fs.symlink(outside, path.join(dir, "escape"));
      expect(await search({ pattern: "**/*" })).not.toContain(
        path.join(dir, "escape"),
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("get_file_info", () => {
  it("reports a file's metadata as key: value lines", async () => {
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "12345");
    await fs.chmod(file, 0o640);
    const lines = textOf(
      await call(client, "get_file_info", { path: file }),
    ).split("\n");
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "size",
      "created",
      "modified",
      "accessed",
      "isDirectory",
      "isFile",
      "permissions",
    ]);
    expect(lines[0]).toBe("size: 5");
    expect(lines[4]).toBe("isDirectory: false");
    expect(lines[5]).toBe("isFile: true");
    // Windows has no POSIX mode bits: a writable file always reports 666.
    expect(lines[6]).toBe(
      process.platform === "win32" ? "permissions: 666" : "permissions: 640",
    );
    // Dates are rendered with Date#toString, in the server's local time zone.
    expect(lines[2]).toMatch(/^modified: \w{3} \w{3} \d{2} \d{4} /);
  });

  it("reports a directory", async () => {
    const text = textOf(await call(client, "get_file_info", { path: dir }));
    expect(text).toContain("isDirectory: true");
    expect(text).toContain("isFile: false");
  });
});

describe("list_allowed_directories", () => {
  it("lists the directories the server was built with", async () => {
    const result = await call(client, "list_allowed_directories");
    expect(textOf(result)).toBe(`Allowed directories:\n${dir}`);
  });
});

describe("grep_search", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(
      path.join(dir, "nested", "sample.txt"),
      "First line\nTarget regex line 123\nLast line\n",
    );
    await fs.writeFile(
      path.join(dir, "other.log"),
      "Random text\nANOTHER target\n",
    );
  });

  it("finds regex matches with line numbers", async () => {
    const result = await call(client, "grep_search", {
      path: dir,
      pattern: "Target.*\\d+",
    });
    expect(textOf(result)).toContain("sample.txt:2: Target regex line 123");
  });

  it("supports case-insensitive search", async () => {
    const result = await call(client, "grep_search", {
      path: dir,
      pattern: "another",
      caseSensitive: false,
    });
    expect(textOf(result)).toContain("other.log:2: ANOTHER target");
  });

  it('returns "No matches found" when pattern does not match', async () => {
    const result = await call(client, "grep_search", {
      path: dir,
      pattern: "NON_EXISTING_PATTERN_XYZ",
    });
    expect(textOf(result)).toBe("No matches found");
  });
});

describe("two servers in one process", () => {
  it("keep separate allow-lists (#4854)", async () => {
    const other = await makeTempDir("mcp-fs-other-");
    const second = await connect([other]);
    try {
      await fs.writeFile(path.join(dir, "mine.txt"), "mine");
      await fs.writeFile(path.join(other, "theirs.txt"), "theirs");
      expect(await allowedDirectoriesOf(second.client)).toEqual([other]);
      expect(await allowedDirectoriesOf(client)).toEqual([dir]);
      const crossed = await call(second.client, "get_file_info", {
        path: path.join(dir, "mine.txt"),
      });
      expect(textOf(crossed)).toMatch(/^Access denied/);
      const own = await call(second.client, "get_file_info", {
        path: path.join(other, "theirs.txt"),
      });
      expect(own.isError).toBeFalsy();
      expect(textOf(own)).toContain("size:");
    } finally {
      await second.close();
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
