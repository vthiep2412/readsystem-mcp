import fs from "fs/promises";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  call,
  connect,
  makeTempDir,
  quietStderr,
  textOf,
  type Connected,
} from "./helpers.js";

let dir: string;
let conn: Connected;
let client: Client;

beforeEach(async () => {
  quietStderr();
  dir = await makeTempDir("mcp-fs-line-endings-");
  conn = await connect([dir]);
  client = conn.client;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("get_file_line_endings", () => {
  it("detects CRLF line endings in a file", async () => {
    const file = path.join(dir, "crlf.txt");
    await fs.writeFile(file, "line1\r\nline2\r\nline3\r\n");

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("crlf (3 line endings)");
  });

  it("detects LF line endings in a file", async () => {
    const file = path.join(dir, "lf.txt");
    await fs.writeFile(file, "line1\nline2\nline3\n");

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("lf (3 line endings)");
  });

  it("detects mixed line endings in a file", async () => {
    const file = path.join(dir, "mixed.txt");
    await fs.writeFile(file, "line1\r\nline2\nline3\r\n");

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("mixed (2 CRLF, 1 LF)");
  });

  it("reports none (empty) for an empty file", async () => {
    const file = path.join(dir, "empty.txt");
    await fs.writeFile(file, "");

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("none (empty)");
  });

  it("reports none (binary) for a binary file", async () => {
    const file = path.join(dir, "binary.bin");
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a, 0x03]);
    await fs.writeFile(file, binaryData);

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("none (binary)");
  });

  it("reports none for a file with no line breaks", async () => {
    const file = path.join(dir, "single.txt");
    await fs.writeFile(file, "single line without breaks");

    const result = await call(client, "get_file_line_endings", { path: file });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("none");
  });

  it("inspects a directory non-recursively by default", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "a\r\nb\r\n");
    await fs.writeFile(path.join(dir, "b.txt"), "a\nb\n");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "c.txt"), "c\r\n");

    const result = await call(client, "get_file_line_endings", { path: dir });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("a.txt: crlf");
    expect(text).toContain("b.txt: lf");
    expect(text).not.toContain("c.txt");
    expect(text).toContain("Total: 2 files (1 CRLF, 1 LF, 0 mixed, 0 none)");
  });

  it("inspects a directory recursively when recursive is true", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "a\r\nb\r\n");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "c.txt"), "c\r\n");

    const result = await call(client, "get_file_line_endings", {
      path: dir,
      recursive: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("a.txt: crlf");
    expect(text).toContain("sub/c.txt: crlf");
    expect(text).toContain("Total: 2 files (2 CRLF, 0 LF, 0 mixed, 0 none)");
  });
});

describe("convert_line_endings", () => {
  it("converts CRLF to LF in a single file", async () => {
    const file = path.join(dir, "convert-to-lf.txt");
    await fs.writeFile(file, "first\r\nsecond\r\nthird\r\n");

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "lf",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Converted");

    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("first\nsecond\nthird\n");
    expect(content.includes("\r")).toBe(false);
  });

  it("converts LF to CRLF in a single file", async () => {
    const file = path.join(dir, "convert-to-crlf.txt");
    await fs.writeFile(file, "first\nsecond\nthird\n");

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "crlf",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Converted");

    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("first\r\nsecond\r\nthird\r\n");
  });

  it("normalizes mixed line endings to LF", async () => {
    const file = path.join(dir, "mixed-to-lf.txt");
    await fs.writeFile(file, "line1\r\nline2\nline3\r\n");

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "lf",
    });
    expect(result.isError).toBeFalsy();

    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("line1\nline2\nline3\n");
  });

  it("normalizes mixed line endings to CRLF", async () => {
    const file = path.join(dir, "mixed-to-crlf.txt");
    await fs.writeFile(file, "line1\r\nline2\nline3\r\n");

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "crlf",
    });
    expect(result.isError).toBeFalsy();

    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("line1\r\nline2\r\nline3\r\n");
  });

  it("preserves binary files without corruption", async () => {
    const file = path.join(dir, "app.bin");
    const binaryData = Buffer.from([0x00, 0x0d, 0x0a, 0x0a, 0xff, 0xfe]);
    await fs.writeFile(file, binaryData);

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "lf",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Skipped binary file");

    const after = await fs.readFile(file);
    expect(after).toEqual(binaryData);
  });

  it("reports unchanged when file already matches target format", async () => {
    const file = path.join(dir, "already-lf.txt");
    await fs.writeFile(file, "hello\nworld\n");

    const result = await call(client, "convert_line_endings", {
      path: file,
      target: "lf",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Unchanged");
  });

  it("converts files in a directory recursively", async () => {
    await fs.writeFile(path.join(dir, "root.txt"), "a\r\nb\r\n");
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "nested", "deep.txt"), "c\r\nd\r\n");
    const binFile = path.join(dir, "nested", "data.bin");
    const binData = Buffer.from([0x00, 0x0d, 0x0a]);
    await fs.writeFile(binFile, binData);

    const result = await call(client, "convert_line_endings", {
      path: dir,
      target: "lf",
      recursive: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Converted 2 file(s) to LF");
    expect(text).toContain("root.txt");
    expect(text).toContain("nested/deep.txt");
    expect(text).toContain("1 binary skipped");

    expect(await fs.readFile(path.join(dir, "root.txt"), "utf-8")).toBe("a\nb\n");
    expect(
      await fs.readFile(path.join(dir, "nested", "deep.txt"), "utf-8"),
    ).toBe("c\nd\n");
    expect(await fs.readFile(binFile)).toEqual(binData);
  });
});
